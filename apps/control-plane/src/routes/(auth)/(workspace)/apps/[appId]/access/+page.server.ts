import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ request, url }) => ({
  accessSaved: request.method === "GET" && url.searchParams.get("accessSaved") === "1",
});
