import { redirect } from "@sveltejs/kit";
import { sessionMember } from "#server/page-auth";
import { workspacePath } from "#lib/workspace-path";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const { organization } = await sessionMember();

  redirect(303, workspacePath(organization.slug));
};
