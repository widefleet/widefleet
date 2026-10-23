import { error, json } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { verifyAccessToken } from "#server/access-token";
import { cliContextRequest, readCliContext } from "#server/cli-login-context";
import { remoteOperation } from "#server/remote-support";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ request, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const authorization = request.headers.get("authorization");
  const id = cliContextRequest.safeParse(url.searchParams.get("request"));

  if (!authorization?.startsWith("Bearer ")) error(401, "A platform access token is required");

  if (!id.success) error(400, "Invalid CLI login request");
  const runtime = await getRuntime();

  const verified = await verifyAccessToken(
    authorization.slice(7),
    await runtime.auth.api.getJwks(),
    runtime.configuration,
  ).catch(() => error(401, "Invalid or expired access token"));

  return json(
    await remoteOperation(() =>
      readCliContext(runtime.database.db, id.data, verified.sub, verified.authority.organizationId),
    ),
  );
};
