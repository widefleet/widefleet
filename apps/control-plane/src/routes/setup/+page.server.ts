import { error, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { readInstallation } from "#server/installation-store";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });

  const runtime = await getRuntime();

  if (runtime.configuration.ARTIFACT_STORAGE_PROVIDER === "r2")
    error(503, "Use the initialization command to create the hosted administrator");

  if ((await readInstallation(runtime.database.db)).ownerId) redirect(303, "/sign-in");

  if (!runtime.emailSignIn)
    error(503, "Configure email delivery or LOGIN_CODE_DELIVERY=console before interactive setup");
};
