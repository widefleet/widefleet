import { error, redirect } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { remoteOperation } from "#server/remote-support";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
  const state = url.searchParams.get("state");
  const issuer = url.searchParams.get("iss");

  if (!state || !issuer) error(400, "Invalid login callback");
  const runtime = await getRuntime();
  const code = url.searchParams.get("code");
  const failure = url.searchParams.get("error");

  const status = await remoteOperation(() =>
    runtime.cliLogin.complete({
      state,
      issuer,
      code,
      error: failure,
    }),
  );

  redirect(303, `/cli-login/done?status=${status}`);
};
