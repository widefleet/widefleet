import { eq } from "drizzle-orm";
import { organization } from "#server/auth-schema";
import { redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
  const runtime = await getRuntime();
  const { session, user } = locals;

  if (!session || !user) {
    const next = new URLSearchParams({ next: url.pathname + url.search });
    const email = url.searchParams.get("email");

    if (email) next.set("email", email);
    redirect(303, `/sign-in?${next}`);
  }

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
