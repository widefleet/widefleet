import { error } from "@sveltejs/kit";
import { identifier, screenshotNumber } from "@platform/contracts";
import { iconCache, iconResponse, missingIconResponse, readAppIcon } from "#server/app-icons";
import { findAppScreenshot } from "#server/app-screenshots";
import { pageFailure, pagePrincipal } from "#server/page-auth";
import { getRuntime } from "#server/runtime";
import type { RequestHandler } from "./$types";

// An app's page loads its screenshots from the workspace's address, as it loads the icon.
export const GET: RequestHandler = async ({ params, url }) => {
  const appId = identifier.safeParse(params.appId);
  const number = screenshotNumber.safeParse(Number(params.number));

  if (!appId.success || !number.success) error(404, "Screenshot not found");
  const principal = await pagePrincipal();
  const runtime = await getRuntime();

  const image = await readAppIcon(
    runtime.database.db,
    runtime.storage,
    principal,
    appId.data,
    (manifest) => findAppScreenshot(manifest, number.data),
  );

  if (image.isErr()) return pageFailure(image.error);
  const cacheControl = iconCache(url.searchParams.get("deployment"), image.value.deploymentId);

  return image.value.icon
    ? iconResponse(image.value.icon, cacheControl)
    : missingIconResponse(cacheControl);
};
