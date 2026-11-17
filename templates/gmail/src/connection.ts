import { connectionLaunch } from "./connection-launch.ts";
import { oauthCredentials } from "./oauth.ts";
import { z } from "zod";
import { authentication, gmailScope } from "./auth.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { initialize } from "./database.ts";
import { authorizationPage, connectionPage } from "./page.ts";

const linkedAccount = z.object({
  id: z.string(),
  accountId: z.string(),
  scope: z.string().nullable(),
  providerEmail: z.string().nullable(),
});

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });

  for (const cookie of cookies) headers.append("set-cookie", cookie);

  return new Response(null, { status: 303, headers });
};

export const accountConnection = (environment: Environment, properties: Properties) => {
  const context = async () => {
    const identity = caller.parse(properties.caller);
    await initialize(environment.DB);

    return { identity, id: await callerId(identity) };
  };

  const account = async (id: string) => {
    const row = await environment.DB.prepare(
      'SELECT account.id, accountId, scope, providerEmail FROM account JOIN "user" ON "user".id = account.userId WHERE userId = ? AND providerId = ?',
    )
      .bind(id, "google")
      .first();

    return row ? linkedAccount.parse(row) : null;
  };

  const configuration = async () => {
    const { missing, credentials } = await oauthCredentials(environment, "google", "GOOGLE");

    if (missing.length)
      return {
        status: "setup_required",
        missing,
        connectUrl: environment.WIDEFLEET_ORIGIN,
      } as const;
    z.string().min(32).parse(credentials.authSecret);

    return { status: "configured", credentials } as const;
  };

  const token = async () => {
    if (!caller.safeParse(properties.caller).success)
      return { status: "authentication_required" } as const;
    const { identity, id } = await context();
    const config = await configuration();

    if (config.status !== "configured") return config;
    const linked = await account(id);

    if (!linked)
      return { status: "connection_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

    if (!linked.scope?.split(/[,\s]+/).includes(gmailScope))
      return { status: "permission_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;
    const auth = authentication(environment, identity, id, config.credentials);

    const response = await auth.api.getAccessToken({
      body: { userId: id, accountId: linked.id },
      asResponse: true,
    });

    if (!response.ok) {
      const error = z.object({ code: z.string() }).parse(await response.json());

      // Better Auth hides upstream refresh details. An outage must not delete
      // the connection or be reported as proof that consent was revoked.
      if (error.code === "FAILED_TO_GET_ACCESS_TOKEN") return { status: "refresh_failed" } as const;
      throw new Error("Could not load the account connection");
    }

    const connected = {
      status: "connected",
      accessToken: z.object({ accessToken: z.string().min(1) }).parse(await response.json())
        .accessToken,
    } as const;

    return connected;
  };

  const start = async (request: Request, completionUrl?: string) => {
    const { identity, id } = await context();
    const config = await configuration();

    if (config.status !== "configured")
      return redirect(completionUrl ? `${completionUrl}&error=setup` : "/");
    const auth = authentication(environment, identity, id, config.credentials);

    const established = await auth.api.establishSession({
      headers: request.headers,
      asResponse: true,
    });

    if (!established.ok) throw new Error("Could not establish the account-linking session");
    const cookies = established.headers.getSetCookie();

    const headers = new Headers({
      origin: environment.WIDEFLEET_ORIGIN,
      cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
    });

    const linked = await auth.api.linkSocialAccount({
      headers,
      body: {
        provider: "google",
        callbackURL: completionUrl ?? `${environment.WIDEFLEET_ORIGIN}/`,
        errorCallbackURL: completionUrl
          ? `${completionUrl}&error=connection`
          : `${environment.WIDEFLEET_ORIGIN}/?error=connection`,
        disableRedirect: true,
      },
      asResponse: true,
    });

    if (!linked.ok)
      return redirect(
        completionUrl ? `${completionUrl}&error=connection` : "/?error=connection",
        cookies,
      );
    const destination = z.object({ url: z.url() }).parse(await linked.json()).url;

    return authorizationPage(destination, [...cookies, ...linked.headers.getSetCookie()]);
  };

  const disconnect = async () => {
    const { id } = await context();
    await environment.DB.batch([
      environment.DB.prepare("DELETE FROM account WHERE userId = ? AND providerId = ?").bind(
        id,
        "google",
      ),
      environment.DB.prepare("DELETE FROM session WHERE userId = ?").bind(id),
    ]);

    return { disconnected: true } as const;
  };

  return {
    disconnect,
    prepare: async (input: { completionUrl: string }) => {
      const { id } = await context();
      const config = await configuration();

      if (config.status !== "configured")
        throw new Error("The connector requires administrator setup");

      return connectionLaunch(environment.DB, id, environment.WIDEFLEET_ORIGIN).prepare(input);
    },
    personalStatus: async () => {
      const { id } = await context();
      const config = await configuration();
      const linked = await account(id);

      return {
        setup: config.status === "configured" ? "ready" : "required",
        connection: linked ? "connected" : "disconnected",
        account: linked
          ? { id: linked.accountId, label: linked.providerEmail ?? linked.accountId }
          : null,
      } as const;
    },
    status: async () => {
      if (!caller.safeParse(properties.caller).success)
        return { status: "authentication_required" } as const;
      const { id } = await context();
      const config = await configuration();

      if (config.status !== "configured") return config;
      const linked = await account(id);

      return {
        status: linked ? "connected" : "connection_required",
        accountId: linked?.accountId ?? null,
        connectUrl: environment.WIDEFLEET_ORIGIN,
      } as const;
    },
    request: async (url: string, headers = new Headers()) => {
      const result = await token();

      if (result.status !== "connected") return result;
      headers.set("authorization", `Bearer ${result.accessToken}`);
      const response = await fetch(url, { headers, redirect: "manual" });

      if (response.status === 401)
        return { status: "reconnect_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

      if (response.status === 403) return { status: "access_denied" } as const;

      if (response.status === 404) return { status: "not_found" } as const;

      if (response.status === 429)
        return { status: "rate_limited", retryAfter: response.headers.get("retry-after") } as const;

      if (!response.ok && response.status !== 302)
        throw new Error(`Gmail request failed (HTTP ${response.status})`);

      const connected = { status: "connected", response } as const;

      return connected;
    },
    fetch: async (request: Request) => {
      if (!caller.safeParse(properties.caller).success) return new Response(null, { status: 401 });
      const { identity, id } = await context();
      const url = new URL(request.url);

      if (url.origin !== environment.WIDEFLEET_ORIGIN) return new Response(null, { status: 400 });

      if (
        request.method === "GET" &&
        ["/connect/start", "/connect/complete"].includes(url.pathname)
      ) {
        const launch = connectionLaunch(environment.DB, id, url.origin);
        const ticket = url.searchParams.get("ticket") ?? "";

        if (url.pathname === "/connect/start") {
          const completionUrl = await launch.start(ticket);

          if (!completionUrl)
            return new Response(
              "This connection link expired or was already used. Return to Widefleet and try again.",
              {
                status: 410,
                headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
              },
            );

          return start(request, completionUrl);
        }

        const completionUrl = await launch.complete(ticket);

        if (!completionUrl)
          return new Response(
            "This connection has already completed or expired. Return to Widefleet to check your connection.",
            {
              status: 410,
              headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
            },
          );
        const destination = new URL(completionUrl);

        if (url.searchParams.has("error")) destination.searchParams.set("connectionError", "1");

        return redirect(destination.href);
      }

      if (url.pathname === "/" && request.method === "GET") {
        const linked = await account(id);
        const config = await configuration();

        return connectionPage(
          identity.name,
          linked?.providerEmail ?? linked?.accountId ?? null,
          config.status === "setup_required" ? config.missing : [],
          url.origin,
          url.searchParams.has("error"),
        );
      }

      if (["/connect", "/disconnect"].includes(url.pathname) && request.method === "POST") {
        if (request.headers.get("origin") !== url.origin)
          return new Response("Invalid origin", { status: 403 });

        if (url.pathname === "/disconnect") {
          await disconnect();

          return redirect("/");
        }

        return start(request);
      }

      if (url.pathname === "/auth/callback/google" && request.method === "GET") {
        const config = await configuration();

        if (config.status !== "configured") return redirect("/");

        const auth = authentication(
          environment,
          identity,
          id,
          config.credentials,
          url.searchParams.get("managed_state") ?? undefined,
        );

        const session = await auth.api.getSession({ headers: request.headers });

        if (session?.user.id !== id)
          return new Response(
            "The user who started this connection is no longer signed in. Start again.",
            { status: 403 },
          );

        return auth.handler(request);
      }

      // Token/session endpoints, including the internal bootstrap, stay private.
      return new Response(null, { status: 404 });
    },
  };
};
