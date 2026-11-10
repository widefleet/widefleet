import { building } from "$app/env";
import { APIError } from "better-auth/api";
import type { Handle } from "@sveltejs/kit/hooks";

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
      if (!(cause instanceof APIError) || (cause.statusCode !== 401 && cause.statusCode !== 403))
        throw cause;
    }
  }

  return resolve(event);
};
