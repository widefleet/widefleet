import { building } from "$app/env";
import { APIError } from "better-auth/api";
import { DrizzleQueryError } from "drizzle-orm";
import { error } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";
import { DatabaseUnavailable } from "./errors.ts";

export const handleSession: Handle = async ({ event, resolve }) => {
  event.locals.user = null;
  event.locals.session = null;

  // API endpoints authenticate their own credentials. Browser pages and remote
  // functions share the session read here, including cookie renewal.
  if (!building && !event.url.pathname.startsWith("/api/") && event.request.headers.has("cookie")) {
    const runtime = await event.locals.runtime();

    try {
      const current = await runtime.auth.api.getSession({ headers: event.request.headers });
      event.locals.user = current?.user ?? null;
      event.locals.session = current?.session ?? null;
    } catch (cause) {
      // Better Auth wraps adapter failures in an APIError. Keep an unavailable
      // session store distinct from an expired session or an unexpected bug.
      const failure = cause instanceof APIError ? cause.cause : cause;

      if (failure instanceof DrizzleQueryError || failure instanceof DatabaseUnavailable) {
        runtime.reporting.exception(failure);
        error(503, "Sign-in is temporarily unavailable.");
      }

      if (!(cause instanceof APIError)) throw cause;

      if (cause.statusCode !== 401 && cause.statusCode !== 403) {
        if (cause.statusCode >= 500) runtime.reporting.exception(cause);
        error(cause.statusCode, cause.message);
      }
    }
  }

  return resolve(event);
};
