import { pagePrincipal } from "#server/page-auth";
import { getRuntime } from "#server/runtime";
import type { PageServerLoad } from "./$types";
import { eq } from "drizzle-orm";
import { organizationRuntimes } from "#server/schema";
import { redirect } from "@sveltejs/kit";

export const load: PageServerLoad = async ({ request, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const principal = await pagePrincipal(request);
  const runtime = await getRuntime();

  if (principal.application.admin) {
    const settings = await runtime.settings.read(principal);

    if (settings.error || settings.activation.state !== "active") redirect(303, "/settings");
  }

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
