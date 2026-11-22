import { companySsoAvailable } from "./sso-policy.ts";
import { and, eq } from "drizzle-orm";
import { companyLoginRevision, type Authentication } from "./auth.ts";
import { account } from "./auth-schema.ts";
import type { Principal } from "./identity.ts";
import type { Runtime } from "./runtime.ts";
import { readOrganizationSlug } from "./organization.ts";
import { workspacePath } from "../workspace-path.ts";

export const readCompanyAccount = async (
  runtime: Runtime,
  principal: Principal,
  session: Authentication["$Infer"]["Session"]["session"] | null,
) => {
  const organizationId = principal.application.organizationId;
  const resolved = await runtime.settings.resolve(organizationId);
  const provider = resolved.sso?.providerId ?? null;
  const slug = await readOrganizationSlug(runtime.database.db, organizationId);

  const linked = provider
    ? await runtime.database.db
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.userId, principal.id), eq(account.providerId, provider)))
        .limit(1)
    : [];

  return {
    organizationId,
    provider,
    label: resolved.identity?.provider.label ?? null,
    accountUrl: new URL(workspacePath(slug, "/account"), runtime.configuration.PLATFORM_URL).href,
    linked: linked.length > 0,
    tested: Boolean(
      companySsoAvailable(runtime.configuration, resolved.sso) &&
      session?.identityOrganizationId === organizationId &&
      session?.companyConfiguration === companyLoginRevision(resolved.sso),
    ),
  };
};

export const readSettingsAccount = async (
  runtime: Runtime,
  principal: Principal,
  session: Authentication["$Infer"]["Session"]["session"] | null,
) => ({
  view: await runtime.settings.read(principal),
  ...(await readCompanyAccount(runtime, principal, session)),
  emailSignIn: runtime.emailSignIn,
  platformUrl: runtime.configuration.PLATFORM_URL,
});
