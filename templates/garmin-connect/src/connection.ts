import { z } from "zod";
import { connectionLaunch } from "./connection-launch.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { initialize } from "./database.ts";
import { connectionPage, returnPage, type SaveError, type SavedKeyState } from "./page.ts";
import { base } from "./schema.ts";

// Garmin issues an access token for a Personal API key. A token lasts 24 hours,
// or until the key expires, and cannot be refreshed: the key issues a new one.
const tokenUrl = new URL("personalapitoken-service/personal-api/personal-api-key/token", base).href;

const profileUrl = new URL("userprofile-service/userprofile/settings", base).href;

// A saved token is replaced a minute before it expires, so it outlasts the request.
const tokenMargin = 60_000;

// One request at a time issues a user's new token and holds the row this long;
// overlapping requests check every `renewalPoll` for the token it saves.
const renewalLease = 10_000;

const renewalPoll = 100;

const savedKey = z.object({
  apiKey: z.string(),
  displayName: z.string().nullable(),
  accessToken: z.string().nullable(),
  accessTokenExpiresAt: z.number().nullable(),
  rejected: z.number().transform((value) => value !== 0),
  savedAt: z.number(),
});

const apiKey = z.string().trim().min(1).max(4096);

// Two UUIDs, as connectionLaunch issues them.
const ticket = z.string().regex(/^[\da-f-]{72}$/);

const saveError = z.enum(["rejected", "unavailable"]);

// Garmin answers with a JWT. Its `exp` claim says when it expires, as Garmin's
// own client reads it. Errors leave out the token's text.
const expiry = (token: string) => {
  try {
    const payload = (token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/");
    const claims = z.object({ exp: z.number() }).parse(JSON.parse(atob(payload)));

    return claims.exp * 1000;
  } catch {
    throw new Error("Garmin issued an access token without an expiry");
  }
};

// A request that reaches Garmin, or null when Garmin cannot be reached.
const reach = (url: string, init: RequestInit) => fetch(url, init).catch(() => null);

/** Issues an access token for a key. Garmin refuses keys that expired or were deleted. */
const issue = async (key: string) => {
  const response = await reach(tokenUrl, {
    method: "POST",
    headers: { accept: "*/*", authorization: `ApiKey ${key}` },
  });

  if (!response) return { status: "token_failed" } as const;

  if (response.status === 429)
    return { status: "rate_limited", retryAfter: response.headers.get("retry-after") } as const;

  if (!response.ok) {
    await response.body?.cancel();

    return [400, 401, 403].includes(response.status)
      ? ({ status: "rejected" } as const)
      : ({ status: "token_failed" } as const);
  }

  const accessToken = (await response.text()).trim();

  return { status: "issued", accessToken, expiresAt: expiry(accessToken) } as const;
};

const redirect = (location: string) =>
  new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

const gone = (text: string) =>
  new Response(text, {
    status: 410,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

/**
 * The current user's connection: the Personal API key they saved, encrypted
 * with the app's keys, and the access token last issued for it.
 */
export const keyConnection = (environment: Environment, properties: Properties) => {
  const database = environment.DB;
  const connectUrl = environment.WIDEFLEET_ORIGIN;

  const context = async () => {
    const identity = caller.parse(properties.caller);
    await initialize(database);

    return { identity, id: await callerId(identity) };
  };

  const saved = async (id: string) => {
    const row = await database
      .prepare(
        "SELECT apiKey, displayName, accessToken, accessTokenExpiresAt, rejected, savedAt FROM api_key WHERE userId = ?",
      )
      .bind(id)
      .first();

    return row ? savedKey.parse(row) : null;
  };

  const encrypt = (value: string) => environment.WIDEFLEET_KEYS.encrypt("tokens", value);

  const decrypt = async (value: string) =>
    new TextDecoder().decode(await environment.WIDEFLEET_KEYS.decrypt("tokens", value));

  // Issues a new token for the key this request holds the renewal of. Only that
  // key changes, in case the user saved another meanwhile.
  const renew = async (id: string, key: string) => {
    const issued = await issue(await decrypt(key));

    if (issued.status === "rejected") {
      await database
        .prepare(
          "UPDATE api_key SET rejected = 1, accessToken = NULL, accessTokenExpiresAt = NULL, renewing = NULL WHERE userId = ? AND apiKey = ?",
        )
        .bind(id, key)
        .run();

      return { status: "reconnect_required", connectUrl } as const;
    }

    if (issued.status !== "issued") {
      await database
        .prepare("UPDATE api_key SET renewing = NULL WHERE userId = ? AND apiKey = ?")
        .bind(id, key)
        .run();

      return issued;
    }

    await database
      .prepare(
        "UPDATE api_key SET accessToken = ?, accessTokenExpiresAt = ?, renewing = NULL WHERE userId = ? AND apiKey = ?",
      )
      .bind(await encrypt(issued.accessToken), issued.expiresAt, id, key)
      .run();

    return { status: "connected", accessToken: issued.accessToken, issued: true } as const;
  };

  // The saved token, unless it expires soon or Garmin refused it, or a new one
  // for the key. Overlapping requests wait for the one that issues it, so
  // parallel reads share one token request.
  const token = async (refused: string | null) => {
    if (!caller.safeParse(properties.caller).success)
      return { status: "authentication_required" } as const;
    const { id } = await context();

    // A renewal whose request failed releases the row when its lease ends.
    for (;;) {
      const key = await saved(id);

      if (!key) return { status: "connection_required", connectUrl } as const;

      if (key.rejected) return { status: "reconnect_required", connectUrl } as const;

      const current = key.accessToken === null ? null : await decrypt(key.accessToken);

      if (
        current !== null &&
        current !== refused &&
        key.accessTokenExpiresAt !== null &&
        key.accessTokenExpiresAt - Date.now() > tokenMargin
      )
        return { status: "connected", accessToken: current, issued: false } as const;
      const now = Date.now();

      const claimed = await database
        .prepare(
          "UPDATE api_key SET renewing = ? WHERE userId = ? AND apiKey = ? AND (renewing IS NULL OR renewing <= ?)",
        )
        .bind(now + renewalLease, id, key.apiKey, now)
        .run();

      if (claimed.meta.changes === 1) return renew(id, key.apiKey);
      await new Promise((resolve) => setTimeout(resolve, renewalPoll));
    }
  };

  // Saves a key once Garmin issues a token for it and reads the user's profile
  // with that token, which names the account.
  const save = async (id: string, key: string): Promise<SaveError | null> => {
    const issued = await issue(key);

    if (issued.status !== "issued")
      return issued.status === "rejected" ? "rejected" : "unavailable";

    const response = await reach(profileUrl, {
      headers: { accept: "application/json", authorization: `Bearer ${issued.accessToken}` },
    });

    if (!response) return "unavailable";

    if (!response.ok) {
      await response.body?.cancel();

      return [401, 403].includes(response.status) ? "rejected" : "unavailable";
    }

    const profile = z.object({ displayName: z.string().optional() }).parse(await response.json());

    await database
      .prepare(
        `INSERT INTO api_key (userId, apiKey, displayName, accessToken, accessTokenExpiresAt, rejected, savedAt)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (userId) DO UPDATE SET apiKey = excluded.apiKey, displayName = excluded.displayName,
           accessToken = excluded.accessToken, accessTokenExpiresAt = excluded.accessTokenExpiresAt,
           rejected = 0, renewing = NULL, savedAt = excluded.savedAt`,
      )
      .bind(
        id,
        await encrypt(key),
        profile.displayName ?? null,
        await encrypt(issued.accessToken),
        issued.expiresAt,
        Date.now(),
      )
      .run();

    return null;
  };

  const disconnect = async () => {
    const { id } = await context();
    await database.prepare("DELETE FROM api_key WHERE userId = ?").bind(id).run();

    return { disconnected: true } as const;
  };

  const state = (key: Awaited<ReturnType<typeof saved>>): SavedKeyState =>
    !key
      ? { status: "none" }
      : key.rejected
        ? { status: "rejected", savedAt: key.savedAt }
        : { status: "connected", displayName: key.displayName, savedAt: key.savedAt };

  return {
    disconnect,
    prepare: async (input: { completionUrl: string }) => {
      const { id } = await context();

      return connectionLaunch(database, id, connectUrl).prepare(input);
    },
    personalStatus: async () => {
      const { id } = await context();
      const key = state(await saved(id));

      return {
        setup: "ready",
        connection: key.status === "connected" ? "connected" : "disconnected",
        account:
          key.status === "connected" && key.displayName
            ? { id: key.displayName, label: key.displayName }
            : null,
      } as const;
    },
    status: async () => {
      if (!caller.safeParse(properties.caller).success)
        return { status: "authentication_required" } as const;
      const { id } = await context();
      const key = state(await saved(id));

      if (key.status === "none") return { status: "connection_required", connectUrl } as const;

      if (key.status === "rejected") return { status: "reconnect_required", connectUrl } as const;

      return { status: "connected", account: key.displayName, connectUrl } as const;
    },
    /**
     * Sends one request to Garmin with the user's access token. A saved token
     * Garmin no longer accepts is replaced once.
     */
    send: async (url: string, init: RequestInit) => {
      const first = await token(null);

      if (first.status !== "connected") return first;

      const request = (accessToken: string) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${accessToken}`);

        return fetch(url, { ...init, headers, redirect: "manual" });
      };

      const response = await request(first.accessToken);

      if (response.status !== 401 || first.issued)
        return { status: "connected", response } as const;
      await response.body?.cancel();
      const renewed = await token(first.accessToken);

      if (renewed.status !== "connected") return renewed;

      return { status: "connected", response: await request(renewed.accessToken) } as const;
    },
    fetch: async (request: Request) => {
      if (!caller.safeParse(properties.caller).success) return new Response(null, { status: 401 });
      const { id } = await context();
      const url = new URL(request.url);

      if (url.origin !== environment.WIDEFLEET_ORIGIN) return new Response(null, { status: 400 });
      const launch = connectionLaunch(database, id, url.origin);

      // A connection started from Widefleet asks for the key on this page and
      // returns to Widefleet once it is saved.
      if (request.method === "GET" && url.pathname === "/connect/start") {
        const completion = await launch.start(url.searchParams.get("ticket") ?? "");

        if (!completion)
          return gone(
            "This connection link expired or was already used. Return to Widefleet and try again.",
          );

        const returning = new URL(completion).searchParams.get("ticket") ?? "";

        return redirect(`/?${new URLSearchParams({ ticket: returning }).toString()}`);
      }

      if (request.method === "GET" && url.pathname === "/connect/complete") {
        const completionUrl = await launch.complete(url.searchParams.get("ticket") ?? "");

        if (!completionUrl)
          return gone(
            "This connection has already completed or expired. Return to Widefleet to check your connection.",
          );

        return redirect(completionUrl);
      }

      if (request.method === "GET" && url.pathname === "/") {
        const returning = ticket.safeParse(url.searchParams.get("ticket"));
        const error = saveError.safeParse(url.searchParams.get("error"));

        return connectionPage(
          state(await saved(id)),
          returning.success ? returning.data : null,
          error.success ? error.data : null,
        );
      }

      if (request.method === "POST" && ["/connect", "/disconnect"].includes(url.pathname)) {
        if (request.headers.get("origin") !== url.origin)
          return new Response("Invalid origin", { status: 403 });

        if (url.pathname === "/disconnect") {
          await disconnect();

          return redirect("/");
        }

        const form = await request.formData();
        const key = apiKey.safeParse(form.get("key"));
        const returning = ticket.safeParse(form.get("ticket"));
        const error = key.success ? await save(id, key.data) : "rejected";

        // The page asks again, still on the way back to Widefleet.
        if (error) {
          const query = new URLSearchParams({ error });

          if (returning.success) query.set("ticket", returning.data);

          return redirect(`/?${query.toString()}`);
        }

        if (!returning.success) return redirect("/");

        // The app allows forms to send only to itself, and Chromium applies that
        // to the redirects after a form too. The form ends on this app's page,
        // which then navigates back to Widefleet.
        return returnPage(`/connect/complete?ticket=${returning.data}`);
      }

      return new Response(null, { status: 404 });
    },
  };
};
