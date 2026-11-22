import { error } from "@sveltejs/kit";
import { identifier } from "@platform/contracts";
import { getAppDetails } from "#lib/apps.remote";
import { pageMember } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const selected = url.searchParams.get("app");

  if (!selected) return { app: null };
  const id = identifier.safeParse(selected);

  if (!id.success) error(400, "Invalid app identifier");
  const { organization } = await pageMember();
  const { app } = await getAppDetails({ appId: id.data, organizationId: organization.id });

  return { app };
};
