import { getCatalog } from "#lib/catalog.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await getCatalog();
};
