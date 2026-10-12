import { identifier } from "@platform/contracts";
import { error } from "@sveltejs/kit";
import { getAppDetails } from "#lib/apps.remote";
import { pagePrincipal } from "#server/page-auth";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ request, params, url, setHeaders, depends }) => {
  setHeaders({ "cache-control": "private, no-store" });
  // Recheck resource access on each section navigation, including reused layouts.
  depends("app:details", url.href);
  await pagePrincipal(request);
  const appId = identifier.safeParse(params.appId);

  if (!appId.success) error(404, "App not found.");
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  await getAppDetails({ appId: appId.data, search });

  return { appId: appId.data, search, requestId: crypto.randomUUID() };
};
