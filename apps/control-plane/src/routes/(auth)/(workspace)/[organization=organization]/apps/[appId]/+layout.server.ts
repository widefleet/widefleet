import { identifier } from "@platform/contracts";
import { error } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ params, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const appId = identifier.safeParse(params.appId);

  if (!appId.success) error(404, "App not found.");
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 200);

  return { appId: appId.data, search, requestId: crypto.randomUUID() };
};
