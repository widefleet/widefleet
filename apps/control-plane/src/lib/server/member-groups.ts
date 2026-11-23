import { appAccessGroups, googleGroupsScope } from "@platform/contracts";
import { providerIdentity } from "@platform/auth-proxy/identity";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ssoProvider } from "./auth-schema.ts";
import type { DatabaseExecutor } from "./database.ts";
import type { Principal } from "./identity.ts";
import { memberGroups } from "./schema.ts";
import { decryptSecret } from "./secret-encryption.ts";
import { readSsoConfiguration, ssoRuntimeIdentity } from "./sso-settings.ts";

// Apps check a person's company groups when the person signs in to them. Management pages
// have no such sign-in per app, so a company sign-in to Widefleet leaves the groups here, and
// Home shows the apps they open. The groups are as old as that sign-in, as they are for apps.

/**
 * Keeps the groups of a company sign-in, read as app sign-in reads them. A sign-in whose groups
 * cannot be read leaves none, so pages treat them as unknown instead of as empty.
 */
export const rememberMemberGroups = async (
  database: DatabaseExecutor,
  encryptionKey: string,
  organizationId: string,
  userId: string,
  tokens:
    | {
        idToken?: string | undefined;
        accessToken?: string | undefined;
        scopes?: string[] | undefined;
      }
    | undefined,
) => {
  let groups: string[] | null = null;

  try {
    const connection = await readSsoConfiguration(database, encryptionKey, organizationId);

    if (connection && tokens?.idToken) {
      const { provider, scopes } = ssoRuntimeIdentity(connection);

      const result = await providerIdentity(
        provider,
        tokens.idToken,
        tokens.accessToken,
        organizationId,
        Boolean(scopes?.includes(googleGroupsScope)) &&
          // OAuth omits scope when the granted scopes equal those requested.
          (!tokens.scopes?.length || tokens.scopes.includes(googleGroupsScope)),
      );

      groups = result.identity.groups;
    }
  } catch {
    // The directory may refuse or be unreachable. That must not keep anyone from signing in.
    groups = null;
  }

  const member = and(
    eq(memberGroups.userId, userId),
    eq(memberGroups.organizationId, organizationId),
  );

  if (groups === null) await database.delete(memberGroups).where(member);
  else
    await database
      .insert(memberGroups)
      .values({ userId, organizationId, groups })
      .onConflictDoUpdate({
        target: [memberGroups.userId, memberGroups.organizationId],
        set: { groups, updatedAt: new Date() },
      });
};

/** A member's groups at their last company sign-in, or null when none are known. */
export const readMemberGroups = async (
  database: DatabaseExecutor,
  principal: Pick<Principal, "id" | "application">,
) => {
  const [record] = await database
    .select({ groups: memberGroups.groups })
    .from(memberGroups)
    .where(
      and(
        eq(memberGroups.userId, principal.id),
        eq(memberGroups.organizationId, principal.application.organizationId),
      ),
    );

  return record ? appAccessGroups.parse(record.groups) : null;
};

/**
 * The scopes a company sign-in to Widefleet requests, when they differ from the saved ones.
 * Entra names a person's groups only to a sign-in that may read their profile, which app
 * sign-in requests too.
 */
export const companySignInScopes = async (
  database: DatabaseExecutor,
  encryptionKey: string,
  providerId: string,
) => {
  const [provider] = await database
    .select({ type: ssoProvider.appIdentityType, oidcConfig: ssoProvider.oidcConfig })
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerId));

  if (provider?.type !== "entra" || !provider.oidcConfig) return undefined;

  const { scopes } = z
    .looseObject({ scopes: z.array(z.string()).optional() })
    .parse(JSON.parse(await decryptSecret(encryptionKey, provider.oidcConfig)));

  // Without saved scopes, Better Auth requests these four.
  return [
    ...new Set([...(scopes ?? ["openid", "email", "profile", "offline_access"]), "User.Read"]),
  ];
};
