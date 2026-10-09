import { dev, version } from "$app/env";
import { userFromHeaders } from "./lib/server/identity.ts";
import { error } from "@sveltejs/kit";
import type { Handle, HandleServerError } from "@sveltejs/kit/hooks";
import { captureError } from "./lib/server/capture-error.ts";
import { receiveBrowserError } from "./lib/server/browser-errors.ts";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.requestId = crypto.randomUUID();

  if (dev) {
    event.locals.user = {
      id: "local-development",
      name: "Lokale Entwicklung",
      email: null,
      groups: [],
    };
  } else {
    const identity = userFromHeaders(event.request.headers);

    if (identity.isErr()) error(401, "Bitte über die Plattform anmelden.");
    event.locals.user = identity.value;
  }

  if (event.url.pathname === "/_widefleet/errors") return receiveBrowserError(event);

  const response = await resolve(event);

  const entry = JSON.stringify({
    widefleet: 1,
    kind: "request",
    source: "server",
    buildId: version,
    deploymentId: event.platform?.env.WIDEFLEET_DEPLOYMENT_ID ?? null,
    requestId: event.locals.requestId,
    route: event.route.id ?? event.url.pathname,
    method: event.request.method,
    status: response.status,
    message: `${event.request.method} ${event.route.id ?? event.url.pathname}: ${response.status}`,
  });

  if (response.status >= 500 && !event.locals.errorReported) console.error(entry);
  else console.info(entry);

  return response;
};

export const handleError: HandleServerError = ({ kind, error: cause, event }) => {
  if (kind === "unknown" || cause.status >= 500) captureError(cause, event);
};
