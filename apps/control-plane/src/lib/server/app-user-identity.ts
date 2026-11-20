import { and, eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { appCaller } from "@platform/contracts";
import { issuer } from "@platform/auth-proxy/identity";
import { member, user, account } from "./auth-schema.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import type { Principal } from "./identity.ts";
import type { createSettingsService } from "./settings.ts";

/**
 * The member's app identity, as app sign-in issues it. Without required company
 * SSO, apps sign in through this Widefleet account. With it, the member's company
 * account names the identity: its subject is the `sub`, or Entra's object ID.
 */
export const createAppUserIdentity =
  (
    database: Database,
    configuration: Configuration,
    settings: ReturnType<typeof createSettingsService>,
  ) =>
  async (principal: Principal) => {
    const organizationId = principal.application.organizationId;
    const current = await settings.resolve(organizationId);

    if (current.errors.length)
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "Company sign-in configuration is unavailable",
      });

    if (!current.identity) {
      // App sign-in through Widefleet admits only members with a verified email.
      const [membership] = await database
        .select({ emailVerified: user.emailVerified })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.userId, principal.id), eq(member.organizationId, organizationId)));

      if (!membership?.emailVerified)
        throw new APIError("FORBIDDEN", {
          message: "This account cannot sign in to this organization's apps through Widefleet",
        });

      return appCaller.parse({
        issuer: `${configuration.PLATFORM_URL}/api/auth`,
        subject: principal.id,
        name: principal.name,
      });
    }

    const providerId = current.sso?.providerId;

    const linked = providerId
      ? await database
          .select({ subject: account.accountId })
          .from(account)
          .where(and(eq(account.userId, principal.id), eq(account.providerId, providerId)))
      : [];

    // Required SSO admits only company sessions, so a member normally has one
    // linked account. A recovery session may not.
    if (linked.length !== 1 || !linked[0])
      throw new APIError("FORBIDDEN", {
        message: "Sign in with your company account to manage personal connections.",
      });

    return appCaller.parse({
      issuer: issuer(current.identity.provider),
      subject: linked[0].subject,
      name: principal.name,
    });
  };
