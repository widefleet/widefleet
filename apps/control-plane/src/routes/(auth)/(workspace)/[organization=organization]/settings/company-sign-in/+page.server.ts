import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ setHeaders, url }) => {
  setHeaders({ "cache-control": "private, no-store" });

  return {
    loginFailed: url.searchParams.has("error"),
  };
};
