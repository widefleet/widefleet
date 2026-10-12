import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ request, url }) => ({
  saved: request.method === "GET" && url.searchParams.get("saved") === "1",
});
