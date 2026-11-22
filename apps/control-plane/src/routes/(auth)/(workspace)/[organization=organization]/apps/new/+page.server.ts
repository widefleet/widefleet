import { error } from "@sveltejs/kit";
import { pageMember } from "#server/page-auth";
import { getApps } from "#lib/apps.remote";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const { principal, organization } = await pageMember();

  if (!principal.creator) error(403, "You do not have permission to create apps.");
  const { apps } = await getApps({ organizationId: organization.id });
  const parentId = url.searchParams.get("parent");

  const parent = apps.find(
    (app) => app.id === parentId && app.state !== "deleting" && !app.parentId,
  );

  if (parentId !== null && !parent)
    error(404, "The original app is no longer available. This preview cannot be created.");

  return { parentId: parent?.id ?? "" };
};
