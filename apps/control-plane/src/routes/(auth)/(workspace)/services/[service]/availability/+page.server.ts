import { error } from "@sveltejs/kit";
import { getAppServices } from "#lib/services.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const catalog = await getAppServices();

  if (!catalog.admin) error(403, "Organization administrator permission is required");

  const service = catalog.entries.find(
    (entry) => entry.appId === params.service || entry.slug === params.service,
  );

  if (!service) error(404, "API not found");

  return { service, saved: url.searchParams.get("saved") === "1" };
};
