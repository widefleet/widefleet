import { pageOrganizations } from "#server/page-auth";
import { getUserSession } from "#server/session";
import { localDestination } from "#server/navigation";
import { getRuntime } from "#server/runtime";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const runtime = await getRuntime();
  const { user, session } = getUserSession();

  return {
    organizations: await pageOrganizations(),
    canCreateOrganization: await runtime.onboarding.available({
      userId: user.id,
      identityOrganizationId: session.identityOrganizationId ?? null,
    }),
    next: localDestination(url.searchParams.get("next")),
  };
};
