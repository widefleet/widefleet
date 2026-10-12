import { env } from "cloudflare:workers";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { userFromHeaders } from "./lib/server/identity.ts";
import { captureError } from "./lib/server/capture-error.ts";
import { receiveBrowserError } from "./lib/server/browser-errors.ts";
import type { PlatformContext } from "./lib/server/context.ts";

const handle = createStartHandler((render) => {
  for (const match of render.router.state.matches) {
    if (match.error) captureError(match.error);
  }

  return defaultStreamHandler(render);
});

export default createServerEntry({
  async fetch(request) {
    const identity = userFromHeaders(request.headers);

    if (!import.meta.env.DEV && identity.isErr())
      return new Response("Bitte über die Plattform anmelden.", { status: 401 });

    const context: PlatformContext = {
      user: import.meta.env.DEV
        ? { id: "local-development", name: "Lokale Entwicklung", email: null, groups: [] }
        : identity.unwrap(),
      requestId: crypto.randomUUID(),
      reportedErrors: new Set(),
    };

    const url = new URL(request.url);

    if (url.pathname === "/_widefleet/errors") return receiveBrowserError(request, context);

    let response: Response;

    try {
      response = await handle(request, { context });
    } catch (cause) {
      captureError(cause, context, request);
      response = new Response("Die Anfrage konnte nicht verarbeitet werden.", { status: 500 });
    }

    const entry = JSON.stringify({
      widefleet: 1,
      kind: "request",
      source: "server",
      buildId: __WIDEFLEET_BUILD_ID__,
      deploymentId: env.WIDEFLEET_DEPLOYMENT_ID ?? null,
      requestId: context.requestId,
      route: url.pathname,
      method: request.method,
      status: response.status,
      message: `${request.method} ${url.pathname}: ${response.status}`,
    });

    if (response.status >= 500 && context.reportedErrors.size === 0) console.error(entry);
    else console.info(entry);

    const result = new Response(response.body, response);

    result.headers.set("cache-control", "private, no-store");

    return result;
  },
});
