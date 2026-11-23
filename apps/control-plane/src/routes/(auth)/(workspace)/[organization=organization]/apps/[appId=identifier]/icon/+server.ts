import { error } from "@sveltejs/kit";
import { identifier } from "@platform/contracts";
import { iconCache, iconResponse, missingIconResponse, readAppIcon } from "#server/app-icons";
import { pageFailure, pagePrincipal } from "#server/page-auth";
import { getRuntime } from "#server/runtime";
import type { RequestHandler } from "./$types";

// Workspace pages load app icons from their own address. An <img> cannot send the API's
// organization header, but here the request hook has already checked the organization.
export const GET: RequestHandler = async ({ params, url }) => {
  const appId = identifier.safeParse(params.appId);

  if (!appId.success) error(404, "App icon not found");
  const principal = await pagePrincipal();
  const runtime = await getRuntime();
  const icon = await readAppIcon(runtime.database.db, runtime.storage, principal, appId.data);

  if (icon.isErr()) return pageFailure(icon.error);
  const cacheControl = iconCache(url.searchParams.get("deployment"), icon.value.deploymentId);

  return icon.value.icon
    ? iconResponse(icon.value.icon, cacheControl)
    : missingIconResponse(cacheControl);
};
