import { redirect } from "@sveltejs/kit";
import { workspacePath } from "#lib/workspace-path";
import type { PageServerLoad } from "./$types";

// Settings has no overview, so it opens the first section and keeps the query.
export const load: PageServerLoad = ({ params, url }) => {
  redirect(308, workspacePath(params.organization, `/settings/company-sign-in${url.search}`));
};
