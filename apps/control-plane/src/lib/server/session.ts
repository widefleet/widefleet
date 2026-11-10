import { building } from "$app/env";
import { APIError } from "better-auth/api";
import { DrizzleQueryError } from "drizzle-orm";
import { error, redirect } from "@sveltejs/kit";
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

  if (
    !building &&
    !event.isRemoteRequest &&
    event.route.id?.split("/").includes("(auth)") &&
    (!event.locals.user || !event.locals.session)
  ) {
    // POST URLs can contain a remote form's transport parameters. Return to its
    // page after sign-in, while retaining normal GET filters and device codes.
    const next = new URLSearchParams({
      next:
        event.request.method === "GET" ? event.url.pathname + event.url.search : event.url.pathname,
    });

    if (event.route.id === "/(auth)/device") {
      const email = event.url.searchParams.get("email");

      if (email) next.set("email", email);
    }

    if (event.route.id === "/(auth)/invitations/[invitationId]" && event.params["invitationId"]) {
      const runtime = await event.locals.runtime();
      const company = await runtime.invitations.companySignIn(event.params["invitationId"]);

      if (company) next.set("organization", company.slug);
    }

    redirect(303, `/sign-in?${next}`);
  }

  return resolve(event);
};
