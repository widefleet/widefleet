import { connectionLaunch } from "./connection-launch.ts";
import { z } from "zod";
import { approvals } from "./approval.ts";
import { authentication } from "./auth.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { initialize } from "./database.ts";
import { authorizationPage, connectionPage, type EnvironmentListing } from "./page.ts";

const linkedAccount = z.object({
  id: z.string(),
  accountId: z.string(),
  scope: z.string().nullable(),
  providerEmail: z.string().nullable(),
});

// An account connected without consent to act as the user in Dataverse
// reconnects to grant it. Microsoft may name the scope with its resource.
const granted = (linked: z.infer<typeof linkedAccount>) =>
  (linked.scope ?? "")
    .split(/[,\s]+/)
    .some((name) => name.replace(/^https:\/\/[^/]+\//, "") === "user_impersonation");

// The environments the Global Discovery Service lists for the user.
const instances = z.object({
  value: z.array(
    z.object({
      FriendlyName: z.string(),
      ApiUrl: z.url(),
      State: z.number(),
      IsUserSysAdmin: z.boolean().optional(),
    }),
  ),
});

const cachedToken = z.object({ accessToken: z.string(), expiresAt: z.number() });

// Microsoft's answer to a refresh for one environment.
const environmentTokens = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
  refresh_token: z.string().min(1).optional(),
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
      .bind(id, "microsoft")
      .first();

    return row ? linkedAccount.parse(row) : null;
  };

  // The organization's Entra application, from the app's secrets.
  const configuration = async () => {
    const read = async (name: string) => {
      try {
        return await environment.WIDEFLEET_SECRETS.get(name);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith("App secret is not configured"))
          throw error;

        return "";
      }
    };

    const credentials = {
      clientId: await read("MICROSOFT_CLIENT_ID"),
      clientSecret: await read("MICROSOFT_CLIENT_SECRET"),
    };

    const missing = [
      ...(credentials.clientId ? [] : ["MICROSOFT_CLIENT_ID"]),
      ...(credentials.clientSecret ? [] : ["MICROSOFT_CLIENT_SECRET"]),
    ];

    if (missing.length)
      return {
        status: "setup_required",
        missing,
        connectUrl: environment.WIDEFLEET_ORIGIN,
      } as const;

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

    if (!granted(linked))
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

  /** The environments the user can open, from the Global Discovery Service. */
  const environments = async () => {
    const result = await token();

    if (result.status !== "connected") return result;

    const response = await fetch(
      "https://globaldisco.crm.dynamics.com/api/discovery/v2.0/Instances",
      {
        headers: { authorization: `Bearer ${result.accessToken}`, accept: "application/json" },
        redirect: "manual",
      },
    );

    if (response.status === 401)
      return { status: "reconnect_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

    if (response.status === 429)
      return { status: "rate_limited", retryAfter: response.headers.get("retry-after") } as const;

    if (!response.ok) throw new Error(`Dataverse discovery failed (HTTP ${response.status})`);

    return {
      status: "connected",
      environments: instances
        .parse(await response.json())
        .value.filter((instance) => instance.State === 0)
        .map((instance): EnvironmentListing => ({
          name: instance.FriendlyName,
          environment: new URL(instance.ApiUrl).host,
          administrator: instance.IsUserSysAdmin === true,
        })),
    } as const;
  };

  /**
   * An access token for one environment. Microsoft issues one per resource; the
   * account's refresh token, consented for Dataverse, gets it.
   */
  const environmentToken = async (id: string, url: string) => {
    const row = await environment.DB.prepare(
      "SELECT accessToken, expiresAt FROM resource_token WHERE userId = ? AND resource = ?",
    )
      .bind(id, url)
      .first();

    const cached = row ? cachedToken.parse(row) : null;

    if (cached && cached.expiresAt > Date.now() + 60_000)
      return {
        status: "connected",
        accessToken: new TextDecoder().decode(
          await environment.WIDEFLEET_KEYS.decrypt("tokens", cached.accessToken),
        ),
      } as const;
    const config = await configuration();

    if (config.status !== "configured") return config;

    const stored = z
      .object({ refreshToken: z.string().nullable() })
      .nullable()
      .parse(
        await environment.DB.prepare(
          "SELECT refreshToken FROM account WHERE userId = ? AND providerId = ?",
        )
          .bind(id, "microsoft")
          .first(),
      )?.refreshToken;

    if (!stored)
      return { status: "connection_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

    const response = await fetch(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.credentials.clientId,
          client_secret: config.credentials.clientSecret,
          refresh_token: new TextDecoder().decode(
            await environment.WIDEFLEET_KEYS.decrypt("tokens", stored),
          ),
          scope: `${url}/user_impersonation offline_access`,
        }),
        redirect: "manual",
      },
    );

    // Microsoft answers 400 when consent or the session is no longer valid.
    if (response.status === 400)
      return { status: "reconnect_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

    if (!response.ok) return { status: "refresh_failed" } as const;
    const issued = environmentTokens.parse(await response.json());

    // Saved only while the account still holds the refresh token this request
    // used, so a request still running after a disconnect or a reconnect never
    // restores the previous grant. The token is cached first because the
    // rotation below changes the refresh token it checks.
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO resource_token (userId, resource, accessToken, expiresAt)
         SELECT ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM account WHERE userId = ? AND providerId = ? AND refreshToken = ?
         )
         ON CONFLICT (userId, resource) DO UPDATE SET accessToken = excluded.accessToken,
         expiresAt = excluded.expiresAt`,
      ).bind(
        id,
        url,
        await environment.WIDEFLEET_KEYS.encrypt("tokens", issued.access_token),
        Date.now() + issued.expires_in * 1000,
        id,
        "microsoft",
        stored,
      ),
      // Microsoft may rotate the refresh token; the newest one stays usable.
      ...(issued.refresh_token
        ? [
            environment.DB.prepare(
              "UPDATE account SET refreshToken = ? WHERE userId = ? AND providerId = ? AND refreshToken = ?",
            ).bind(
              await environment.WIDEFLEET_KEYS.encrypt("tokens", issued.refresh_token),
              id,
              "microsoft",
              stored,
            ),
          ]
        : []),
    ]);

    return { status: "connected", accessToken: issued.access_token } as const;
  };

  // Starts provider authorization from the connector's page or from a
  // single-use launch ticket, which returns to the completion URL afterwards.
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
        provider: "microsoft",
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
        "microsoft",
      ),
      environment.DB.prepare("DELETE FROM session WHERE userId = ?").bind(id),
      environment.DB.prepare("DELETE FROM resource_token WHERE userId = ?").bind(id),
    ]);

    return { disconnected: true } as const;
  };

  return {
    disconnect,
    environments,
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

      if (!linked)
        return { status: "connection_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

      if (!granted(linked))
        return { status: "permission_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

      return {
        status: "connected",
        accountId: linked.accountId,
        connectUrl: environment.WIDEFLEET_ORIGIN,
      } as const;
    },
    /**
     * Sends one request to an environment with the user's token for it, which
     * Microsoft issues for that environment only.
     */
    send: async (url: string, init: RequestInit) => {
      const ready = await token();

      if (ready.status !== "connected") return ready;
      const { id } = await context();
      const result = await environmentToken(id, new URL(url).origin);

      if (result.status !== "connected") return result;
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${result.accessToken}`);

      const response = await fetch(url, { ...init, headers, redirect: "manual" });

      // A rejected token is not offered again; the next call asks Microsoft.
      if (response.status === 401)
        await environment.DB.prepare("DELETE FROM resource_token WHERE userId = ? AND resource = ?")
          .bind(id, new URL(url).origin)
          .run();

      return { status: "connected", response } as const;
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
        // A failing discovery leaves the account's controls on the page.
        const listed = linked && granted(linked) ? await environments().catch(() => null) : null;

        return connectionPage(
          linked?.providerEmail ?? linked?.accountId ?? null,
          config.status === "setup_required" ? config.missing : [],
          url.origin,
          url.searchParams.has("error"),
          await approvals(environment.DB, id).level(),
          listed?.status === "connected" ? listed.environments : null,
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

      if (url.pathname === "/auth/callback/microsoft" && request.method === "GET") {
        const config = await configuration();

        if (config.status !== "configured") return redirect("/");

        const auth = authentication(environment, identity, id, config.credentials);

        // Tokens of the previous grant never outlive a new connection.
        await environment.DB.prepare("DELETE FROM resource_token WHERE userId = ?").bind(id).run();

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
