import { pagePrincipal, pageOrganizations } from "#server/page-auth";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ request, url, depends }) => {
  // Recheck roles on workspace navigation and after explicit permission changes.
  depends("workspace:principal", url.href);

  const principal = await pagePrincipal(request);

  return { principal, organizations: await pageOrganizations(request) };
};
