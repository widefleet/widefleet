import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) =>
  (await locals.runtime()).workloadIdentity.issue(request);
