import { eq } from "drizzle-orm";
import { organization } from "#server/auth-schema";
import { sessionSignIn } from "#server/identity";
import { getUserSession } from "#server/page-auth";
import { getRuntime } from "#server/runtime";
import { companySignInLimit } from "#server/sso-policy";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ "referrer-policy": "no-referrer" });
  const runtime = await getRuntime();
  const { session, user } = getUserSession();

  // The approved token keeps the limit of the sign-in that approves it.
  const organizationId = await companySignInLimit(
    runtime.database.db,
    sessionSignIn(user, session),
  );

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
