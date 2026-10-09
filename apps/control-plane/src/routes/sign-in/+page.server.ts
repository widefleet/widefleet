import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { readInstallation } from "#server/installation-store";
import { companyAccountProvider } from "#server/company-identity";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const next = url.searchParams.get("next") ?? "/";
  const runtime = await getRuntime();

  if (!(await readInstallation(runtime.database.db)).ownerId) redirect(303, "/setup");
  const identity = runtime.configuration.IDENTITY;

  return {
    provider: identity ? companyAccountProvider(identity) : null,
    label: identity?.provider.label ?? "Unternehmen",
    localPasswordEnabled: runtime.configuration.LOCAL_PASSWORD_ENABLED,
    next: next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/",
  };
};
