import { getUserSession, pageOrganizations } from "#server/page-auth";
import { localDestination } from "#server/navigation";
import { chosenDestination } from "#lib/workspace-path";
import { getRuntime } from "#server/runtime";
import { sessionSignIn } from "#server/identity";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url }) => {
  const runtime = await getRuntime();
  const { user, session } = getUserSession();
  const next = localDestination(url.searchParams.get("next"));

  return {
    organizations: (await pageOrganizations()).map((organization) => ({
      ...organization,
      destination: chosenDestination(next, organization.slug),
    })),
    canCreateOrganization: await runtime.onboarding.available(sessionSignIn(user, session)),
    next,
    // MCP sign-in sends people here to pick the organization a client connects to.
    connecting: new URL(next, "https://navigation.invalid").pathname === "/mcp/sign-in",
  };
};
