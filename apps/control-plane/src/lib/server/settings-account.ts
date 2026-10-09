import { and, eq } from "drizzle-orm";
import { companyLoginRevision } from "./auth.ts";
import { account } from "./auth-schema.ts";
import { companyAccountProvider } from "./company-identity.ts";
import type { Principal } from "./identity.ts";
import type { Runtime } from "./runtime.ts";

export const readSettingsAccount = async (
  runtime: Runtime,
  principal: Principal,
  headers: Headers,
) => {
  const view = await runtime.settings.read(principal);
  const identity = runtime.configuration.IDENTITY;
  const provider = identity ? companyAccountProvider(identity) : null;

  const linked = provider
    ? await runtime.database.db
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.userId, principal.id), eq(account.providerId, provider)))
        .limit(1)
    : [];

  const current = await runtime.auth.api.getSession({ headers });

  return {
    view,
    reporting: await runtime.reporting.read(principal),
    platformUrl: runtime.configuration.PLATFORM_URL,
    provider,
    linked: linked.length > 0,
    tested: Boolean(
      identity &&
      current?.session.companyConfiguration === companyLoginRevision(runtime.configuration),
    ),
  };
};
