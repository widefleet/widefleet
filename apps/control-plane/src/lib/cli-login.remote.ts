import { command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { getRuntime } from "#server/runtime";
import { remoteOperation } from "#server/remote-support";
import { cliConsent } from "#server/cli-consent";
import { saveCliContext } from "#server/cli-login-context";
import { organizationIdentifier } from "@platform/contracts";

export const chooseCliPlatform = command(
  z.object({
    request: z.string().max(128),
    ticket: z.string().max(128),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  }),
  async ({ request, ticket, email }) => {
    const runtime = await getRuntime();
    const login = await remoteOperation(() => runtime.cliLogin.inspect(request, ticket));
    let origin = login.platformUrl;

    if (!origin) {
      try {
        origin = await runtime.discoverPlatform(email.slice(email.lastIndexOf("@") + 1));
      } catch {
        error(503, "Could not find your company's platform. Retry or use its direct sign-in link.");
      }
    }

    return remoteOperation(() => runtime.cliLogin.select(request, ticket, origin, email));
  },
);

export const selectCliOrganization = command(
  z.object({
    oauthQuery: z.string().max(16384),
    sessionId: z.string(),
    organizationId: organizationIdentifier,
  }),
  async ({ oauthQuery, sessionId, organizationId }) => {
    const runtime = await getRuntime();
    const { request } = getRequestEvent();
    const session = await runtime.auth.api.getSession({ headers: request.headers });

    if (!session || session.session.id !== sessionId || session.session.recovery)
      error(403, "Your sign-in changed. Reload this page before connecting the CLI.");
    const query = new URLSearchParams(oauthQuery);

    const consent = await remoteOperation(() =>
      cliConsent(query, runtime.configuration, runtime.database.db),
    );

    if (!consent) error(400, "Invalid CLI authorization request");
    const headers = new Headers(request.headers);
    headers.set("x-widefleet-organization", organizationId);

    const principal = await runtime.identity.authenticate(
      new Request(request.url, { headers }),
      "platform:read",
    );

    if (principal.isErr()) error(403, principal.error.message);
    await remoteOperation(() =>
      saveCliContext(
        runtime.database.db,
        query.get("code_challenge") ?? "",
        principal.value.id,
        organizationId,
      ),
    );

    return { selected: true };
  },
);
