import { redirect } from "@sveltejs/kit";
import { getSettings } from "#lib/settings.remote";
import { pageMember } from "#server/page-auth";
import { workspacePath } from "#lib/workspace-path";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ setHeaders, url }) => {
  setHeaders({ "cache-control": "private, no-store" });

  const { organization } = await pageMember();

  // An active connection is managed on its own page.
  if ((await getSettings({ organizationId: organization.id })).view.ssoRequired)
    redirect(303, workspacePath(organization.slug, "/settings/company-sign-in"));

  return { loginFailed: url.searchParams.has("error") };
};
