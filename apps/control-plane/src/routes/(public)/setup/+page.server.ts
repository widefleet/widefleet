import { error, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { readInstallation } from "#server/installation-store";
import { readOrganizationSlug } from "#server/organization";
import { installationOrganizationId } from "#lib/organization";
import { workspacePath } from "#lib/workspace-path";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const runtime = await getRuntime();

  if (runtime.configuration.ARTIFACT_STORAGE_PROVIDER === "r2")
    error(503, "Use the initialization command to create the hosted administrator");

  if ((await readInstallation(runtime.database.db)).ownerId) redirect(303, "/sign-in");

  if (!runtime.emailSignIn)
    error(503, "Configure email delivery or LOGIN_CODE_DELIVERY=console before interactive setup");

  // Like a new organization, the first administrator starts on Manage.
  return {
    next: workspacePath(
      await readOrganizationSlug(runtime.database.db, installationOrganizationId),
      "/apps",
    ),
  };
};
