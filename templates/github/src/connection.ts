import { connectionLaunch } from "./connection-launch.ts";
import { oauthCredentials, revokeManagedGrant } from "./oauth.ts";
import { z } from "zod";
import { approvals } from "./approval.ts";
import { authentication, scopes } from "./auth.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { initialize } from "./database.ts";
import { boundedJson, maximumResponseBytes } from "./input.ts";
import { type GraphQLError, type GraphQLRequest, graphqlResponse } from "./graphql.ts";
import { authorizationPage, connectionPage } from "./page.ts";

const linkedAccount = z.object({
  id: z.string(),
  accountId: z.string(),
  scope: z.string().nullable(),
  providerEmail: z.string().nullable(),
});

/** GitHub's errors, with the type GitHub gives them, such as `NOT_FOUND` or `FORBIDDEN`. */
const githubErrors = (errors: GraphQLError[]) =>
  errors.map((error) => ({
    message: error.message,
    type: error.type ?? null,
    path: error.path ?? null,
  }));

// Seconds until GitHub accepts requests again: its Retry-After header, or the
// reset time of an exhausted rate limit.
const retryAfter = (headers: Headers) => {
  const reset = Number(headers.get("x-ratelimit-reset"));

  if (headers.has("retry-after")) return headers.get("retry-after");

  if (headers.get("x-ratelimit-remaining") !== "0" || !Number.isFinite(reset) || !reset)
    return null;

  return String(Math.max(0, Math.ceil(reset - Date.now() / 1000)));
};

// An account connected for fewer scopes than the methods need reconnects to
// grant the others.
const granted = (linked: z.infer<typeof linkedAccount>) => {
  const scope = new Set(linked.scope?.split(/[,\s]+/));

  return scopes.every((name) => scope.has(name));
};

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
      .bind(id, "github")
      .first();

    return row ? linkedAccount.parse(row) : null;
  };

  // Disconnecting revokes a managed grant at the provider when it supports
  // revocation. The saved tokens are removed either way.
  const revoke = async (id: string) => {
    const binding = environment.WIDEFLEET_OAUTH;

    const saved = z
      .object({ accessToken: z.string().nullable(), refreshToken: z.string().nullable() })
      .nullable()
      .parse(
        await environment.DB.prepare(
          "SELECT accessToken, refreshToken FROM account WHERE userId = ? AND providerId = ?",
        )
          .bind(id, "github")
          .first(),
      );

    const stored = saved?.refreshToken ?? saved?.accessToken;

    if (!binding || !stored) return;

    try {
      const token = new TextDecoder().decode(
        await environment.WIDEFLEET_KEYS.decrypt("tokens", stored),
      );

      await revokeManagedGrant(binding, "github", token);
    } catch {
      // A grant from the operator's earlier client or a provider outage must
      // not prevent disconnecting.
    }
  };

  const configuration = async () => {
    const { missing, credentials } = await oauthCredentials(environment, "github", "GITHUB");

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
        provider: "github",
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
    await revoke(id);
    await environment.DB.batch([
      environment.DB.prepare("DELETE FROM account WHERE userId = ? AND providerId = ?").bind(
        id,
        "github",
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
    /** Sends one GraphQL request with the user's token. */
    graphql: async (body: GraphQLRequest) => {
      const result = await token();

      if (result.status !== "connected") return result;

      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          authorization: `Bearer ${result.accessToken}`,
          "content-type": "application/json",
          "user-agent": "Widefleet-GitHub",
        },
        body: JSON.stringify(body),
        redirect: "manual",
      });

      if (response.status === 401)
        return { status: "reconnect_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

      const limited = { status: "rate_limited", retryAfter: retryAfter(response.headers) } as const;

      // GitHub answers exhausted and secondary rate limits with 403 or 429 and
      // a REST error body; other request errors are GraphQL errors.
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has("retry-after") ||
            response.headers.get("x-ratelimit-remaining") === "0"))
      )
        return limited;

      const read = await boundedJson(response);

      if (read.status === "too_large")
        return { status: "too_large", maximumBytes: maximumResponseBytes } as const;

      const parsed = read.body === null ? null : graphqlResponse.safeParse(read.body);

      // A failed response without GraphQL errors has no answer to read.
      if (!parsed?.success || (!response.ok && !parsed.data.errors?.length)) {
        if (response.status === 403) return { status: "access_denied" } as const;

        throw new Error(`GitHub request failed (HTTP ${response.status})`);
      }

      const errors = parsed.data.errors ?? [];
      const types = new Set(errors.map((error) => error.type));

      if (types.has("RATE_LIMITED")) return limited;

      if (errors.length) return { status: "github_error", errors: githubErrors(errors) } as const;

      return { status: "connected", data: parsed.data.data ?? {} } as const;
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
          linked?.providerEmail ?? linked?.accountId ?? null,
          config.status === "setup_required" ? config.missing : [],
          url.origin,
          url.searchParams.has("error"),
          await approvals(environment.DB, id).level(),
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

      if (url.pathname === "/auth/callback/github" && request.method === "GET") {
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
