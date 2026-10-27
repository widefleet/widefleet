import { pagePrincipal } from "#server/page-auth";
import { getRuntime } from "#server/runtime";
import type { PageServerLoad } from "./$types";
import { eq } from "drizzle-orm";
import { organizationRuntimes } from "#server/schema";

export const load: PageServerLoad = async ({ request, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const principal = await pagePrincipal(request);
  const runtime = await getRuntime();

  const [execution] = await runtime.database.db
    .select()
    .from(organizationRuntimes)
    .where(eq(organizationRuntimes.organizationId, principal.application.organizationId));

  return {
    platformUrl: runtime.configuration.PLATFORM_URL,
    organizationId: principal.application.organizationId,
    usesAgent: execution?.executor === "agent",
    installationAdmin: principal.admin,
  };
};
