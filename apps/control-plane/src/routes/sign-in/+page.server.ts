import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { getRuntime } from "#server/runtime";
import { readInstallation } from "#server/installation-store";

import { organization, ssoProvider } from "#server/auth-schema";
import { organizationSettings } from "#server/schema";
import { localDestination } from "#server/navigation";
import { installationOrganizationId } from "#lib/organization";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const runtime = await getRuntime();

  if (!(await readInstallation(runtime.database.db)).ownerId) redirect(303, "/setup");
  const slug = url.searchParams.get("organization");

  const [target] = await runtime.database.db
    .select({
      id: organization.id,
      name: organization.name,
      providerId: ssoProvider.providerId,
      appIdentityType: ssoProvider.appIdentityType,
      verified: ssoProvider.domainVerified,
      required: organizationSettings.ssoRequired,
    })
    .from(organization)
    .leftJoin(ssoProvider, eq(ssoProvider.organizationId, organization.id))
    .leftJoin(organizationSettings, eq(organizationSettings.organizationId, organization.id))
    .where(slug ? eq(organization.slug, slug) : eq(organization.id, installationOrganizationId));

  const provider = target?.verified ? target.providerId : null;

  return {
    provider,
    label:
      target?.id === installationOrganizationId
        ? target.appIdentityType === "entra"
          ? "Microsoft"
          : "Company SSO"
        : (target?.name ?? "your company"),
    organizationSlug: slug,
    organizationName: target?.name ?? null,
    emailSignIn: runtime.emailSignIn && !(slug && provider && target?.required),
    email: url.searchParams.get("email") ?? "",
    codeDelivery: runtime.configuration.LOGIN_CODE_DELIVERY,
    next: localDestination(url.searchParams.get("next")),
  };
};
