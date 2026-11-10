import { getSettings } from "#lib/settings.remote";
import { z } from "zod";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent, setHeaders, url }) => {
  setHeaders({ "cache-control": "private, no-store" });
  await parent();
  await getSettings();

  return {
    loginFailed: url.searchParams.has("error"),
    section: z
      .enum(["identity", "reporting", "management"])
      .catch("identity")
      .parse(url.searchParams.get("section")),
  };
};
