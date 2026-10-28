import { pageOrganizations, identityFailure } from "#server/page-auth";
import { localDestination } from "#server/navigation";
import { getRuntime } from "#server/runtime";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const runtime = await getRuntime();
  const person = await runtime.identity.authenticateUser(request, "platform:read");

  if (person.isErr()) return identityFailure(person.error, request);

  return {
    organizations: await pageOrganizations(request),
    canCreateOrganization: await runtime.onboarding.available(person.value),
    next: localDestination(url.searchParams.get("next")),
  };
};
