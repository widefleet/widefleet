import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { companyAccountProvider } from "#server/company-identity";
import { localDestination } from "#server/navigation";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const runtime = await getRuntime();

  if (!runtime.ownerId) redirect(303, "/setup");
  const identity = runtime.configuration.IDENTITY;

  return {
    emailSignIn: runtime.emailSignIn,
    provider: identity ? companyAccountProvider(identity) : null,
    label: identity?.provider.label ?? "Unternehmen",
    localPasswordEnabled: runtime.configuration.LOCAL_PASSWORD_ENABLED,
    next: localDestination(url.searchParams.get("next")),
  };
};
