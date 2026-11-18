import { getSettings } from "#lib/settings.remote";
import { z } from "zod";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders, url }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await getSettings();

  return {
    section: z
      .enum(["identity", "management"])
      .catch("identity")
      .parse(url.searchParams.get("section")),
  };
};
