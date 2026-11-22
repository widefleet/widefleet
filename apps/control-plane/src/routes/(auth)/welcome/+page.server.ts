import { redirect } from "@sveltejs/kit";
import { sessionMember } from "#server/page-auth";
import { workspacePath } from "#lib/workspace-path";
import type { PageServerLoad } from "./$types";

// Setup and sign-up end here before they know the organization's slug.
export const load: PageServerLoad = async () => {
  const { organization } = await sessionMember();

  redirect(303, workspacePath(organization.slug, "/welcome"));
};
