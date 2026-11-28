import type { PageServerLoad } from "./$types";

// The page is rendered with the person's notes and name.
export const load: PageServerLoad = ({ setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
};
