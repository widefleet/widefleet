import { oauthCredentials, type OAuthCredentials } from "./oauth.ts";
import { z } from "zod";
import { authentication } from "./auth.ts";
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
  const headers = new Headers({ location, "cache-control": "no-store" });

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

  const configuration = async () => {
    const { missing, credentials } = await oauthCredentials(environment, "microsoft", "MICROSOFT");

    if (missing.length)
      return {
        status: "setup_required",
        missing,
        connectUrl: environment.WIDEFLEET_ORIGIN,
      } as const;
    z.string().min(32).parse(credentials.authSecret);

    return { status: "configured", credentials } as const;
  };

  const registrationChanged = async (id: string, credentials: OAuthCredentials) => {
    const registration = await environment.DB.prepare(
      "SELECT clientId, managed FROM oauth_registration WHERE userId = ?",
    )
      .bind(id)
      .first<{ clientId: string; managed: number }>();

    // Legacy accounts cannot prove which OAuth registration issued their tokens.
    return registration
      ? registration.clientId !== credentials.clientId ||
          Boolean(registration.managed) !== credentials.managed
      : true;
  };

  const token = async () => {
    if (!caller.safeParse(properties.caller).success)
      return { status: "authentication_required" } as const;
    const { identity, id } = await context();
    const config = await configuration();

    if (config.status !== "configured") return config;
    const linked = await account(id);

    if (linked && (await registrationChanged(id, config.credentials)))
      return { status: "reconnect_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

    if (!linked)
      return { status: "connection_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

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

  return {
    status: async () => {
      if (!caller.safeParse(properties.caller).success)
        return { status: "authentication_required" } as const;
      const { id } = await context();
      const config = await configuration();

      if (config.status !== "configured") return config;
      const linked = await account(id);

      if (linked && (await registrationChanged(id, config.credentials)))
        return { status: "reconnect_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

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
        throw new Error(`OneDrive request failed (HTTP ${response.status})`);

      const connected = { status: "connected", response } as const;

      return connected;
    },
    fetch: async (request: Request) => {
      if (!caller.safeParse(properties.caller).success) return new Response(null, { status: 401 });
      const { identity, id } = await context();
      const url = new URL(request.url);

      if (url.origin !== environment.WIDEFLEET_ORIGIN) return new Response(null, { status: 400 });

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
          await environment.DB.batch([
            environment.DB.prepare("DELETE FROM oauth_registration WHERE userId = ?").bind(id),
            environment.DB.prepare("DELETE FROM account WHERE userId = ? AND providerId = ?").bind(
              id,
              "microsoft",
            ),
            environment.DB.prepare("DELETE FROM session WHERE userId = ?").bind(id),
          ]);

          return redirect("/");
        }

        const config = await configuration();

        if (config.status !== "configured") return redirect("/");
        const auth = authentication(environment, identity, id, config.credentials);

        const established = await auth.api.establishSession({
          headers: request.headers,
          asResponse: true,
        });

        if (!established.ok) throw new Error("Could not establish the account-linking session");
        const cookies = established.headers.getSetCookie();

        const headers = new Headers({
          origin: url.origin,
          cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
        });

        const linked = await auth.api.linkSocialAccount({
          headers,
          body: {
            provider: "microsoft",
            callbackURL: `${url.origin}/`,
            errorCallbackURL: `${url.origin}/?error=connection`,
            disableRedirect: true,
          },
          asResponse: true,
        });

        if (!linked.ok) return redirect("/?error=connection", cookies);
        const destination = z.object({ url: z.url() }).parse(await linked.json()).url;

        return authorizationPage(destination, [...cookies, ...linked.headers.getSetCookie()]);
      }

      if (url.pathname === "/auth/callback/microsoft" && request.method === "GET") {
        const config = await configuration();

        if (config.status !== "configured") return redirect("/");

        const auth = authentication(
          environment,
          identity,
          id,
          config.credentials,
          url.searchParams.get("managed_state") ?? undefined,
          await registrationChanged(id, config.credentials),
        );

        const session = await auth.api.getSession({ headers: request.headers });

        if (session?.user.id !== id)
          return new Response(
            "The user who started this connection is no longer signed in. Start again.",
            { status: 403 },
          );

        const response = await auth.handler(request);
        const destination = response.headers.get("location");

        if (destination === `${url.origin}/` && (await account(id)))
          await environment.DB.prepare(
            "INSERT INTO oauth_registration (userId, clientId, managed) VALUES (?, ?, ?) ON CONFLICT(userId) DO UPDATE SET clientId = excluded.clientId, managed = excluded.managed",
          )
            .bind(id, config.credentials.clientId, Number(config.credentials.managed))
            .run();

        return response;
      }

      // Token/session endpoints, including the internal bootstrap, stay private.
      return new Response(null, { status: 404 });
    },
  };
};
