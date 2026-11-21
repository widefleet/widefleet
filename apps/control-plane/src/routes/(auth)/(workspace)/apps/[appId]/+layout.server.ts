import { identifier } from "@platform/contracts";
import { error, isHttpError, redirect } from "@sveltejs/kit";
import { getAppDetails } from "#lib/apps.remote";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ params, url, setHeaders, depends }) => {
  setHeaders({ "cache-control": "private, no-store" });
  // Recheck resource access on each section navigation, including reused layouts.
  depends("app:details", url.href);
  const appId = identifier.safeParse(params.appId);

  if (!appId.success) error(404, "App not found.");
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 200);

  try {
    await getAppDetails({ appId: appId.data, search });
  } catch (cause) {
    // Members who do not manage the app still see what it exposes.
    if (isHttpError(cause, 404)) redirect(303, `/services/${appId.data}`);
    throw cause;
  }

  return { appId: appId.data, search, requestId: crypto.randomUUID() };
};
