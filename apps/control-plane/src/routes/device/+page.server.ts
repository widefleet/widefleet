import { redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, url }) => {
  const session = await (await getRuntime()).auth.api.getSession({ headers: request.headers });

  if (!session) redirect(303, `/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);

  return { code: url.searchParams.get("user_code") ?? "", name: session.user.name };
};
