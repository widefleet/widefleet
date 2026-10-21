import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { getRuntime } from "#server/runtime";

import { organization, ssoProvider } from "#server/auth-schema";
import { localDestination } from "#server/navigation";
import { installationOrganizationId } from "#lib/organization";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const runtime = await getRuntime();

  if (!runtime.ownerId) redirect(303, "/setup");
  const slug = url.searchParams.get("organization");

  const [target] = await runtime.database.db
    .select({
      id: organization.id,
      name: organization.name,
      providerId: ssoProvider.providerId,
      verified: ssoProvider.domainVerified,
    })
    .from(organization)
    .leftJoin(ssoProvider, eq(ssoProvider.organizationId, organization.id))
    .where(slug ? eq(organization.slug, slug) : eq(organization.id, installationOrganizationId));

  const provider = target?.verified ? target.providerId : null;

  const label =
    target && !slug ? (await runtime.settings.resolve(target.id)).identity?.provider.label : null;

  return {
    provider,
    label: label ?? target?.name ?? "your company",
    organizationSlug: slug,
    organizationName: target?.name ?? null,
    emailSignIn: runtime.emailSignIn && !(slug && provider),
    localPasswordEnabled: runtime.configuration.LOCAL_PASSWORD_ENABLED && !provider,
    next: localDestination(url.searchParams.get("next")),
  };
};
