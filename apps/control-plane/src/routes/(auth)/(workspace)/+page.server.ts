import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
};
