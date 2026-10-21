import { eq } from "drizzle-orm";
import { organization } from "#server/auth-schema";
import { redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, url }) => {
  const runtime = await getRuntime();
  const session = await runtime.auth.api.getSession({ headers: request.headers });

  if (!session) redirect(303, `/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);

  const organizationId = session.session.identityOrganizationId;

  const [company] = organizationId
    ? await runtime.database.db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, organizationId))
    : [];

  return {
    code: url.searchParams.get("user_code") ?? "",
    name: session.user.name,
    sessionId: session.session.id,
    organization: organizationId ? (company?.name ?? "your company") : null,
  };
};
