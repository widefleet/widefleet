import { error, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { readInstallation } from "#server/installation-store";
import { localDestination } from "#server/navigation";
import { organizationPlaceholder, workspacePath } from "#lib/workspace-path";
import type { PageServerLoad } from "./$types";
import { availableSocialProviders } from "#server/social-sign-in";

export const load: PageServerLoad = async ({ url }) => {
  const runtime = await getRuntime();

  if (!(await readInstallation(runtime.database.db)).ownerId) redirect(303, "/setup");

  if (!runtime.publicSignup) error(404, "Public registration is disabled");
  const destination = localDestination(url.searchParams.get("next"));

  return {
    socialProviders: availableSocialProviders(runtime.configuration),
    next: `/organizations?${new URLSearchParams({ next: destination === "/" ? workspacePath(organizationPlaceholder, "/welcome") : destination })}`,
  };
};
