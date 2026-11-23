import { eq } from "drizzle-orm";
import { installationOrganizationId } from "#lib/organization";
import { workspacePath } from "#lib/workspace-path";
import { organization } from "#server/auth-schema";
import { getRuntime } from "#server/runtime";
import type { PageServerLoad } from "./$types";

// Recovery signs in to the installation organization, whose company sign-in it restores.
export const load: PageServerLoad = async () => {
  const runtime = await getRuntime();

  const [installation] = await runtime.database.db
    .select({ slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, installationOrganizationId));

  return {
    destination: installation ? workspacePath(installation.slug, "/settings/company-sign-in") : "/",
  };
};
