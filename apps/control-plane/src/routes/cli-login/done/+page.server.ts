import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store", "referrer-policy": "no-referrer" });

  return { denied: url.searchParams.get("status") === "denied" };
};
