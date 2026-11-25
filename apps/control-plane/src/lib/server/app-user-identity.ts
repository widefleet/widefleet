import { and, eq, isNotNull } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { appCaller, appUserDistinctId } from "@platform/contracts";
import { issuer } from "@platform/auth-proxy/identity";
import { member, user, account, ssoProvider } from "./auth-schema.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import type { Principal } from "./identity.ts";
import type { createSettingsService } from "./settings.ts";

// Apps of organizations without company sign-in sign people in through Widefleet itself.
const widefleetAppIdentity = (configuration: Configuration, userId: string) => ({
  issuer: `${configuration.PLATFORM_URL}/api/auth`,
  subject: userId,
});

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
  async (
    principal: Pick<Principal, "id" | "name"> & {
      application: Pick<Principal["application"], "organizationId">;
    },
  ) => {
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
        ...widefleetAppIdentity(configuration, principal.id),
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

/**
 * The product analytics IDs of a person's app identities, so their app use counts toward
 * their account instead of a second person. Company identities come from the person's
 * company accounts, which exist at sign-in even before company sign-in adds the membership.
 */
export const createAppIdentityLinks = (
  database: Database,
  configuration: Configuration,
  settings: ReturnType<typeof createSettingsService>,
) => {
  const identify = createAppUserIdentity(database, configuration, settings);

  return async (userId: string) => {
    const companies = await database
      .selectDistinct({ organizationId: ssoProvider.organizationId, name: user.name })
      .from(account)
      .innerJoin(ssoProvider, eq(ssoProvider.providerId, account.providerId))
      .innerJoin(user, eq(user.id, account.userId))
      .where(and(eq(account.userId, userId), isNotNull(ssoProvider.organizationId)));

    const identities = await Promise.allSettled(
      companies.flatMap(({ organizationId, name }) =>
        organizationId ? [identify({ id: userId, name, application: { organizationId } })] : [],
      ),
    );

    const callers = [
      widefleetAppIdentity(configuration, userId),
      ...identities.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    ];

    return [...new Set(await Promise.all(callers.map((caller) => appUserDistinctId(caller))))];
  };
};
