import { error, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { readInstallation } from "#server/installation-store";
import { localDestination } from "#server/navigation";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const runtime = await getRuntime();

  if (!(await readInstallation(runtime.database.db)).ownerId) redirect(303, "/setup");

  if (!runtime.publicSignup) error(404, "Public registration is disabled");
  const destination = localDestination(url.searchParams.get("next"));

  return {
    next: `/organizations?${new URLSearchParams({ next: destination === "/" ? "/welcome" : destination })}`,
  };
};
