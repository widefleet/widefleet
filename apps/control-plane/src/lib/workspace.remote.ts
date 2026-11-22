import { getRequestEvent, query } from "$app/server";
import { z } from "zod";
import { organizationSlug } from "@platform/contracts";
import { remoteContext, queryValue } from "#server/remote-support";
import { getRuntime } from "#server/runtime";
import { error, redirect } from "@sveltejs/kit";

// The workspace shell names its organization by the slug in the page URL. Its pages and
// remote functions then name the organization by ID, which stays valid if the slug changes.
export const getWorkspace = query(
  z.object({ organization: organizationSlug }),
  async ({ organization: slug }) => {
    const { user, session } = getRequestEvent().locals;

    // Like `remoteContext`, an ended session sends an open tab to sign-in.
    if (!user || !session) redirect(303, "/sign-in");
    const runtime = await getRuntime();

    const organizations = queryValue(
      await runtime.identity.listOrganizations(user.id, session.identityOrganizationId ?? null),
    );

    const selected = organizations.find((organization) => organization.slug === slug);

    if (!selected) error(404, "Organization not found.");

    const { principal, organization } = await remoteContext({ organizationId: selected.id });

    return { principal, organization, organizations };
  },
);
