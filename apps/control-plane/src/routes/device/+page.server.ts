import { eq } from "drizzle-orm";
import { organization } from "#server/auth-schema";
import { redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { cliConsent } from "#server/cli-consent";
import { remoteOperation } from "#server/remote-support";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
  const runtime = await getRuntime();
  const session = await runtime.auth.api.getSession({ headers: request.headers });

  if (!session) redirect(303, `/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);

  const organizationId = session.session.identityOrganizationId;

  const consent = await remoteOperation(() =>
    cliConsent(url.searchParams, runtime.configuration, runtime.database.db),
  );

  const available = consent ? await runtime.identity.organizations(request) : null;
  const organizations = available?.isOk() ? available.value : [];

  const [company] = organizationId
    ? await runtime.database.db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, organizationId))
    : [];

  return {
    code: consent?.code ?? url.searchParams.get("user_code") ?? "",
    consent,
    organizations,
    selectedOrganization:
      organizations.find(
        (item) => item.id === session.session.activeOrganizationId && !item.ssoRequired,
      )?.id ??
      (organizations.length === 1 && !organizations[0]?.ssoRequired ? organizations[0]?.id : null),
    platformUrl: runtime.configuration.PLATFORM_URL,
    name: session.user.name,
    sessionId: session.session.id,
    organization: organizationId ? (company?.name ?? "your company") : null,
  };
};
