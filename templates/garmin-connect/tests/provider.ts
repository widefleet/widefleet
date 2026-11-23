import { Request, Response } from "miniflare";

type Answer = { status: number; body: object | null; headers: Record<string, string> };

type State = {
  issued: number;
  // Answers the token endpoint with this status instead of a token.
  tokenStatus: number | null;
  // An answer that replaces the next API response.
  answer: Answer | null;
  // How long the token endpoint takes to answer, in milliseconds.
  tokenDelay: number;
  // Whether requests fail before reaching Garmin, as during a network outage.
  offline: boolean;
};

const api = "https://personal.connectapi.garmin.com";

// Garmin issues access tokens for 24 hours, in seconds.
const lifetime = 24 * 60 * 60;

const base64url = (value: string) =>
  btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

// A synthetic ZIP archive's first bytes, which are not valid UTF-8 text.
export const activityFile = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01]);

/** A stand-in for Garmin's Personal API: its token endpoint and some reads. */
export const provider = () => {
  // Personal API keys by user, and the user of each issued access token.
  const keys = new Map<string, string>();
  const access = new Map<string, string>();
  const calls: { method: string; url: string }[] = [];

  const state: State = {
    issued: 0,
    tokenStatus: null,
    answer: null,
    tokenDelay: 0,
    offline: false,
  };

  return {
    state,
    calls,
    /** Creates a key for a user, as the Personal API Key page of Garmin Connect does. */
    createKey: (user: string) => {
      const key = `synthetic-key-${user}-${crypto.randomUUID()}`;
      keys.set(key, user);

      return key;
    },
    /** Deletes a key, which also invalidates the tokens it issued. */
    deleteKey: (key: string) => {
      const user = keys.get(key);
      keys.delete(key);

      for (const [token, owner] of access) if (owner === user) access.delete(token);
    },
    /** Invalidates every issued token, as if each had expired. */
    expireTokens: () => access.clear(),
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const path = `${url.origin}${url.pathname}`;

      if (state.offline) throw new Error("Garmin cannot be reached");

      if (path === `${api}/personalapitoken-service/personal-api/personal-api-key/token`) {
        if (request.method !== "POST") throw new Error("The token endpoint takes POST");
        await new Promise((resolve) => setTimeout(resolve, state.tokenDelay));

        if (state.tokenStatus) return new Response(null, { status: state.tokenStatus });
        const user = keys.get((request.headers.get("authorization") ?? "").replace(/^ApiKey /, ""));

        if (!user) return Response.json({ message: "Unauthorized" }, { status: 401 });
        state.issued++;

        const payload = base64url(
          JSON.stringify({ sub: user, exp: Math.floor(Date.now() / 1000) + lifetime }),
        );

        const token = `${base64url(JSON.stringify({ alg: "RS256" }))}.${payload}.synthetic-signature-${crypto.randomUUID()}`;
        access.set(token, user);

        // Garmin answers with the token itself, not JSON.
        return new Response(`${token}\n`, { headers: { "content-type": "text/plain" } });
      }

      const user = access.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

      if (!user) return new Response(null, { status: 401 });
      calls.push({ method: request.method, url: url.href });

      if (state.answer) {
        const { status, body, headers } = state.answer;
        state.answer = null;

        return body === null
          ? new Response(null, { status, headers })
          : Response.json(body, { status, headers });
      }

      if (path === `${api}/userprofile-service/userprofile/settings`)
        return Response.json({ displayName: `${user}-runner`, measurementSystem: "metric" });

      if (path === `${api}/activitylist-service/activities/search/activities`)
        return Response.json([
          { activityId: 1001, activityName: `${user}'s morning run`, distance: 5012.4 },
        ]);

      if (path === `${api}/sleep-service/sleep/dailySleep`)
        return Response.json({
          calendarDate: url.searchParams.get("date"),
          sleepTimeSeconds: 27000,
        });

      if (path === `${api}/hrv-service/hrv/2026-11-20`) return new Response(null, { status: 204 });

      if (path === `${api}/download-service/files/activity/1001`)
        return new Response(activityFile, {
          headers: { "content-type": "application/x-zip-compressed" },
        });

      throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`);
    },
  };
};
