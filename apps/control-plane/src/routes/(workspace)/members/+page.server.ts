import { z } from "zod";
import { getMembers } from "#lib/members.remote";
import { pagePrincipal } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await pagePrincipal(request);
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 200);

  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .catch(1)
    .parse(url.searchParams.get("page") ?? 1);

  await getMembers({ search, page });

  return {
    search,
    page,
    saved: request.method === "GET" && url.searchParams.get("saved") === "1",
  };
};
