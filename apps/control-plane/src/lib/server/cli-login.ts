import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, like, lt } from "drizzle-orm";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { verification } from "./auth-schema.ts";
import { cliScopes } from "./auth-options.ts";
import type { Configuration } from "./config.ts";
import type { DatabaseExecutor } from "./database.ts";
import { cloudPlatformUrl, discoveredPlatformUrl } from "./platform-discovery.ts";

export const cliCallbackUrl = `${cloudPlatformUrl}/cli-login/callback`;

const prefix = "cli-login:";

const challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const token = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const secret = () => randomBytes(32).toString("base64url");

export const cliApprovalCode = (value: string) =>
  `${value.slice(0, 4)}-${value.slice(4, 8)}`.toUpperCase();

const startInput = z.object({
  code_challenge: challenge,
  poll_hash: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().min(1).max(512),
});

const storedLogin = startInput.extend({
  browserToken: token,
  callbackState: token,
  platformUrl: discoveredPlatformUrl.nullable(),
  status: z.enum(["awaiting_selection", "awaiting_authorization", "authorized", "denied"]),
  code: z.string().max(2048).nullable(),
});

export const createCliLogin = (database: DatabaseExecutor, configuration: Configuration) => {
  const enabled = () => {
    if (configuration.PLATFORM_URL !== cloudPlatformUrl) throw new APIError("NOT_FOUND");
  };

  const read = async (id: string) => {
    enabled();

    const [row] = await database
      .select()
      .from(verification)
      .where(eq(verification.id, prefix + challenge.parse(id)));

    if (!row || row.expiresAt <= new Date())
      throw new APIError("GONE", { message: "This login expired. Run widefleet login --restart." });

    return { row, value: storedLogin.parse(JSON.parse(row.value)) };
  };

  const browser = async (id: string, ticket: string) => {
    const login = await read(id);

    if (hash(token.parse(ticket)) !== hash(login.value.browserToken))
      throw new APIError("UNAUTHORIZED", { message: "Invalid login link" });

    return login;
  };

  const authorizationUrl = (value: z.infer<typeof storedLogin>, email: string) => {
    if (!value.platformUrl) throw new APIError("CONFLICT");
    const url = new URL("/api/auth/oauth2/authorize", value.platformUrl);
    url.search = new URLSearchParams({
      client_id: "platform-cli",
      response_type: "code",
      redirect_uri: cliCallbackUrl,
      code_challenge_method: "S256",
      code_challenge: value.code_challenge,
      state: value.callbackState,
      scope: value.scope,
      resource: `${value.platformUrl}/api/v1`,
      prompt: "consent",
      login_hint: email,
    }).toString();

    return url.href;
  };

  return {
    async start(input: z.infer<typeof startInput>) {
      enabled();
      const scopes = input.scope.split(" ");

      if (
        !scopes.every((scope) => cliScopes.includes(scope)) ||
        !["openid", "offline_access"].every((scope) => scopes.includes(scope))
      )
        throw new APIError("BAD_REQUEST", { message: "Unsupported CLI permissions" });

      // These are short-lived rendezvous records, not credentials. The PKCE
      // verifier and platform tokens never pass through this service.
      await database
        .delete(verification)
        .where(and(like(verification.id, `${prefix}%`), lt(verification.expiresAt, new Date())));

      const value = storedLogin.parse({
        ...input,
        browserToken: secret(),
        callbackState: secret(),
        platformUrl: null,
        status: "awaiting_selection",
        code: null,
      });

      await database
        .insert(verification)
        .values({
          id: prefix + input.code_challenge,
          identifier: prefix + value.callbackState,
          value: JSON.stringify(value),
          expiresAt: new Date(Date.now() + 30 * 60_000),
        })
        .onConflictDoNothing();
      const login = await read(input.code_challenge);

      if (login.value.poll_hash !== input.poll_hash || login.value.scope !== input.scope)
        throw new APIError("CONFLICT", { message: "This login request already exists" });
      const url = new URL("/cli-login", cloudPlatformUrl);
      url.searchParams.set("request", input.code_challenge);
      url.searchParams.set("ticket", login.value.browserToken);

      return {
        request_id: input.code_challenge,
        verification_uri: url.href,
        user_code: cliApprovalCode(input.code_challenge),
        expires_in: Math.max(0, Math.floor((login.row.expiresAt.getTime() - Date.now()) / 1000)),
        interval: 3,
      };
    },

    async inspect(id: string, ticket: string) {
      const { value } = await browser(id, ticket);

      return { status: value.status, platformUrl: value.platformUrl, code: cliApprovalCode(id) };
    },

    async select(id: string, ticket: string, origin: string, email: string) {
      const { row, value } = await browser(id, ticket);
      const platformUrl = discoveredPlatformUrl.parse(origin);

      if (value.status !== "awaiting_selection") {
        if (value.status === "awaiting_authorization" && value.platformUrl === platformUrl)
          return authorizationUrl(value, email);
        throw new APIError("CONFLICT", { message: "This login already has a destination" });
      }

      const selected = { ...value, platformUrl, status: "awaiting_authorization" as const };

      const changed = await database
        .update(verification)
        .set({ value: JSON.stringify(selected) })
        .where(
          and(
            eq(verification.id, row.id),
            eq(verification.value, row.value),
            gt(verification.expiresAt, new Date()),
          ),
        )
        .returning({ id: verification.id });

      if (!changed.length)
        throw new APIError("CONFLICT", { message: "This login changed. Reload the page." });

      return authorizationUrl(selected, email);
    },

    async complete(input: {
      state: string;
      issuer: string;
      code?: string | null;
      error?: string | null;
    }) {
      enabled();

      const [row] = await database
        .select()
        .from(verification)
        .where(eq(verification.identifier, prefix + token.parse(input.state)));

      if (!row || row.expiresAt <= new Date()) throw new APIError("GONE");
      const value = storedLogin.parse(JSON.parse(row.value));

      if (
        !value.platformUrl ||
        input.issuer !== `${value.platformUrl}/api/auth` ||
        Boolean(input.code) === Boolean(input.error)
      )
        throw new APIError("BAD_REQUEST", { message: "Invalid login callback" });
      const denied = Boolean(input.error);
      const code = input.code ? z.string().min(1).max(2048).parse(input.code) : null;

      if (
        (value.status === "authorized" && !denied && value.code === code) ||
        (value.status === "denied" && denied)
      )
        return value.status;

      if (value.status !== "awaiting_authorization")
        throw new APIError("BAD_REQUEST", { message: "Invalid login callback" });

      const changed = await database
        .update(verification)
        .set({
          value: JSON.stringify({ ...value, status: denied ? "denied" : "authorized", code }),
          // The provider's authorization codes last ten minutes. Leave a margin
          // and retain the result for retries after a lost polling response.
          expiresAt: new Date(Math.min(row.expiresAt.getTime(), Date.now() + 9 * 60_000)),
        })
        .where(and(eq(verification.id, row.id), eq(verification.value, row.value)))
        .returning({ id: verification.id });

      if (!changed.length) throw new APIError("CONFLICT", { message: "Login already completed" });

      return denied ? "denied" : "authorized";
    },

    async poll(id: string, pollToken: string) {
      const { value, row } = await read(id);

      if (hash(token.parse(pollToken)) !== value.poll_hash)
        throw new APIError("UNAUTHORIZED", { message: "Invalid login request" });

      return {
        status: value.status,
        platform_url: value.platformUrl,
        code: value.code,
        expires_at: row.expiresAt.toISOString(),
      };
    },
  };
};

export const cliLoginPlugin = (login: ReturnType<typeof createCliLogin>) => ({
  id: "cli-login",
  rateLimit: [
    { pathMatcher: (path: string) => path === "/cli-login/start", window: 60, max: 3 },
    { pathMatcher: (path: string) => path === "/cli-login/poll", window: 60, max: 60 },
  ],
  endpoints: {
    startCliLogin: createAuthEndpoint(
      "/cli-login/start",
      { method: "POST", body: startInput },
      async (context) => {
        context.setHeader("cache-control", "no-store");

        return context.json(await login.start(context.body));
      },
    ),
    pollCliLogin: createAuthEndpoint(
      "/cli-login/poll",
      { method: "POST", body: z.object({ request_id: challenge, poll_token: token }) },
      async (context) => {
        context.setHeader("cache-control", "no-store");

        return context.json(await login.poll(context.body.request_id, context.body.poll_token));
      },
    ),
  },
});
