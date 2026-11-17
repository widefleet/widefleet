import { error } from "@sveltejs/kit";
import { getAppServices, getServiceUserAccess } from "#lib/services.remote";
import { getRuntime } from "#server/runtime";
import { issuer } from "@platform/auth-proxy/identity";
import { pagePrincipal } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const catalog = await getAppServices();

  if (!catalog.admin) error(403, "Organization administrator permission is required");

  const service =
    catalog.entries.find((entry) => entry.appId === params.service) ??
    catalog.entries.find((entry) => entry.slug === params.service);

  if (!service) error(404, "API not found");

  const runtime = await getRuntime();
  const principal = await pagePrincipal();
  const settings = await runtime.settings.resolve(principal.application.organizationId);

  return {
    service,
    access: await getServiceUserAccess({ appId: service.appId }),
    identityIssuer: settings.identity
      ? issuer(settings.identity.provider)
      : `${runtime.configuration.PLATFORM_URL}/api/auth`,
    saved: url.searchParams.get("saved") === "1",
  };
};
