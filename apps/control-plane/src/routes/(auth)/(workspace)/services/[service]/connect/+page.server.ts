import { error } from "@sveltejs/kit";
import { identifier } from "@platform/contracts";
import { getAppServices } from "#lib/services.remote";
import { getApps } from "#lib/apps.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const catalog = await getAppServices();

  const service =
    catalog.entries.find((entry) => entry.appId === params.service) ??
    catalog.entries.find((entry) => entry.slug === params.service);

  if (!service) error(404, "API not found");
  const applications = await getApps();
  const availableApps = applications.apps.filter((app) => app.id !== service.appId);
  const selected = url.searchParams.get("app");

  if (selected && !identifier.safeParse(selected).success) error(400, "Invalid app identifier");
  const app = selected ? availableApps.find((candidate) => candidate.id === selected) : null;

  if (selected && !app) error(404, "App not found");

  return {
    service,
    applications: availableApps,
    app: app ?? null,
    approval: !catalog.admin && service.accessMode === "approval_required",
  };
};
