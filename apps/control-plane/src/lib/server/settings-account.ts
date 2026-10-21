import { and, eq } from "drizzle-orm";
import { companyLoginRevision } from "./auth.ts";
import { account } from "./auth-schema.ts";
import type { Principal } from "./identity.ts";
import type { Runtime } from "./runtime.ts";

export const readCompanyAccount = async (
  runtime: Runtime,
  principal: Principal,
  headers: Headers,
) => {
  const organizationId = principal.application.organizationId;
  const resolved = await runtime.settings.resolve(organizationId);
  const provider = resolved.sso?.providerId ?? null;

  const linked = provider
    ? await runtime.database.db
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.userId, principal.id), eq(account.providerId, provider)))
        .limit(1)
    : [];

  const current = await runtime.auth.api.getSession({ headers });

  return {
    organizationId,
    provider,
    label: resolved.identity?.provider.label ?? null,
    accountUrl: `${runtime.configuration.PLATFORM_URL}/account`,
    linked: linked.length > 0,
    tested: Boolean(
      resolved.sso?.domainVerified &&
      current?.session.identityOrganizationId === organizationId &&
      current?.session.companyConfiguration === companyLoginRevision(resolved.sso),
    ),
  };
};

export const readSettingsAccount = async (
  runtime: Runtime,
  principal: Principal,
  headers: Headers,
) => ({
  view: await runtime.settings.read(principal),
  ...(await readCompanyAccount(runtime, principal, headers)),
  emailSignIn: runtime.emailSignIn,
  reporting: principal.admin ? await runtime.reporting.read(principal) : null,
  platformUrl: runtime.configuration.PLATFORM_URL,
});
