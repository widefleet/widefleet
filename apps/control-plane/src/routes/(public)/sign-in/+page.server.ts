import { companySsoAvailableSql, operatorTrustedSso } from "#server/sso-policy";
import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { and, eq, exists, gt, or } from "drizzle-orm";
import { getRuntime } from "#server/runtime";
import { readInstallation } from "#server/installation-store";

import { invitation, member, organization, ssoProvider } from "#server/auth-schema";
import { organizationSettings } from "#server/schema";
import { localDestination } from "#server/navigation";
import { installationOrganizationId } from "#lib/organization";
import { availableSocialProviders } from "#server/social-sign-in";

export const load: PageServerLoad = async ({ locals, url }) => {
  const runtime = await getRuntime();

  if (!(await readInstallation(runtime.database.db)).ownerId) redirect(303, "/setup");
  const slug = url.searchParams.get("organization");

  const [target] = await runtime.database.db
    .select({
      id: organization.id,
      name: organization.name,
      providerId: ssoProvider.providerId,
      appIdentityType: ssoProvider.appIdentityType,
      verified: companySsoAvailableSql(runtime.configuration),
      required: organizationSettings.ssoRequired,
    })
    .from(organization)
    .leftJoin(ssoProvider, eq(ssoProvider.organizationId, organization.id))
    .leftJoin(organizationSettings, eq(organizationSettings.organizationId, organization.id))
    .where(slug ? eq(organization.slug, slug) : eq(organization.id, installationOrganizationId));

  const provider = target?.verified ? target.providerId : null;

  const companyOnly =
    provider && target?.required && (slug || operatorTrustedSso(runtime.configuration, target?.id));

  // A signed-in member or invitee reaches this page when an organization requires its own
  // SSO. Only then is their address shared with that organization's provider without a click;
  // anyone can link a signed-in visitor to an arbitrary organization's page.
  const candidate =
    companyOnly &&
    slug &&
    target &&
    locals.user &&
    locals.session?.identityOrganizationId !== target.id &&
    !url.searchParams.has("error")
      ? { organizationId: target.id, userId: locals.user.id, email: locals.user.email }
      : null;

  const database = runtime.database.db;

  const related = candidate
    ? await database
        .select({ id: organization.id })
        .from(organization)
        .where(
          and(
            eq(organization.id, candidate.organizationId),
            or(
              exists(
                database
                  .select()
                  .from(member)
                  .where(
                    and(
                      eq(member.organizationId, candidate.organizationId),
                      eq(member.userId, candidate.userId),
                    ),
                  ),
              ),
              exists(
                database
                  .select()
                  .from(invitation)
                  .where(
                    and(
                      eq(invitation.organizationId, candidate.organizationId),
                      eq(invitation.email, candidate.email.toLowerCase()),
                      eq(invitation.status, "pending"),
                      gt(invitation.expiresAt, new Date()),
                    ),
                  ),
              ),
            ),
          ),
        )
    : [];

  const continueAs = candidate && related.length ? candidate.email : null;

  const next = localDestination(url.searchParams.get("next"));

  const email = url.searchParams.get("email") ?? "";

  // A sign-in link for a device request already names the person's address. Continue
  // with it instead of asking again; a failed attempt returns with an error and waits.
  const autoStart =
    Boolean(email) &&
    !url.searchParams.has("error") &&
    new URL(next, url.origin).pathname === "/device";

  return {
    // Installation setup sends the new administrator here to verify their address.
    fromSetup: url.searchParams.has("setup"),
    signedOut: !locals.session,
    continueAs,
    socialProviders: companyOnly ? [] : availableSocialProviders(runtime.configuration),
    error: url.searchParams.has("error"),
    provider,
    publicSignup: runtime.publicSignup && !slug,
    label:
      target?.id === installationOrganizationId
        ? target.appIdentityType === "entra"
          ? "Microsoft"
          : target.appIdentityType === "google"
            ? "Google Workspace"
            : "Company SSO"
        : (target?.name ?? "your company"),
    organizationSlug: slug,
    organizationName: target?.name ?? null,
    emailSignIn: runtime.emailSignIn && !companyOnly,
    email,
    autoStart,
    codeDelivery: runtime.configuration.LOGIN_CODE_DELIVERY,
    next,
  };
};
