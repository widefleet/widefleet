import { identifier } from "@platform/contracts";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { getAppDetails } from "#lib/apps.remote";
import { pagePrincipal } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, params, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await pagePrincipal(request);
  const appId = identifier.safeParse(params.appId);

  if (!appId.success) error(404, "App not found.");
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  await getAppDetails({ appId: appId.data, search });

  return {
    appId: appId.data,
    search,
    requestId: crypto.randomUUID(),
    accessSaved: request.method === "GET" && url.searchParams.get("accessSaved") === "1",
    saved: request.method === "GET" && url.searchParams.get("saved") === "1",
    accessScope: z
      .enum(["app", "management"])
      .catch("app")
      .parse(url.searchParams.get("scope") ?? (url.searchParams.has("q") ? "management" : "app")),
    tab: z
      .enum(["overview", "deployments", "workflows", "access", "settings"])
      .catch("overview")
      .parse(
        url.searchParams.get("tab") ??
          (url.searchParams.has("q") || url.searchParams.has("accessSaved")
            ? "access"
            : "overview"),
      ),
  };
};
