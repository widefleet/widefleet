import { eq } from "drizzle-orm";
import { organization } from "#server/auth-schema";
import { getUserSession } from "#server/page-auth";
import { getRuntime } from "#server/runtime";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
  const runtime = await getRuntime();
  const { session, user } = getUserSession();

  const organizationId = session.identityOrganizationId;

  const [company] = organizationId
    ? await runtime.database.db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, organizationId))
    : [];

  return {
    code: url.searchParams.get("user_code") ?? "",
    name: user.name,
    sessionId: session.id,
    organization: organizationId ? (company?.name ?? "your company") : null,
  };
};
