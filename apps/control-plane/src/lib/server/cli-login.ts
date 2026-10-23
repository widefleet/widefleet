import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, like, lt } from "drizzle-orm";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { verification } from "./auth-schema.ts";
import type { Configuration } from "./config.ts";
import type { DatabaseExecutor } from "./database.ts";
import { cloudPlatformUrl, discoveredPlatformUrl } from "./platform-discovery.ts";

const prefix = "cli-routing:";

const secret = () => randomBytes(32).toString("base64url");

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const userCode = z.string().min(1).max(128);

const credentials = z.object({ request_id: token, cli_token: token });

const stored = z.object({
  browserHash: z.string(),
  cliHash: z.string(),
  platformUrl: discoveredPlatformUrl.nullable(),
  userCode: userCode.nullable(),
});

export const createCliLogin = (database: DatabaseExecutor, configuration: Configuration) => {
  const enabled = () => {
    if (configuration.PLATFORM_URL !== cloudPlatformUrl) throw new APIError("NOT_FOUND");
  };

  const read = async (id: string, credential: string, channel: "browserHash" | "cliHash") => {
    enabled();

    const [row] = await database
      .select()
      .from(verification)
      .where(eq(verification.id, prefix + token.parse(id)));

    if (!row || row.expiresAt <= new Date())
      throw new APIError("GONE", { message: "This login expired. Run widefleet login again." });
    const value = stored.parse(JSON.parse(row.value));

    if (!timingSafeEqual(Buffer.from(hash(token.parse(credential))), Buffer.from(value[channel])))
      throw new APIError("UNAUTHORIZED", { message: "Invalid CLI login request" });

    return { row, value };
  };

  const save = async (login: Awaited<ReturnType<typeof read>>, value: z.infer<typeof stored>) => {
    const changed = await database
      .update(verification)
      .set({ value: JSON.stringify(value) })
      .where(
        and(
          eq(verification.id, login.row.id),
          eq(verification.value, login.row.value),
          gt(verification.expiresAt, new Date()),
        ),
      )
      .returning({ id: verification.id });

    if (!changed.length)
      throw new APIError("CONFLICT", { message: "This login changed. Reload the page." });
  };

  const inspect = (value: z.infer<typeof stored>) => {
    let url: URL | null = null;

    if (value.platformUrl && value.userCode) {
      url = new URL("/device", value.platformUrl);
      url.searchParams.set("user_code", value.userCode);
    }

    return { platformUrl: value.platformUrl, verificationUri: url?.href ?? null };
  };

  return {
    async start() {
      enabled();
      const id = secret();
      const browserToken = secret();
      const cliToken = secret();
      // Routing only: device grants and tokens are issued directly by Better Auth
      // at the selected installation. This record holds only the public user code.
      await database
        .delete(verification)
        .where(and(like(verification.id, `${prefix}%`), lt(verification.expiresAt, new Date())));
      await database.insert(verification).values({
        id: prefix + id,
        identifier: prefix + id,
        value: JSON.stringify({
          browserHash: hash(browserToken),
          cliHash: hash(cliToken),
          platformUrl: null,
          userCode: null,
        }),
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      const url = new URL("/cli-login", cloudPlatformUrl);
      url.searchParams.set("request", id);
      url.searchParams.set("ticket", browserToken);

      return {
        request_id: id,
        cli_token: cliToken,
        verification_uri: url.href,
        expires_in: 1800,
        interval: 2,
      };
    },
    async inspect(id: string, ticket: string) {
      return inspect((await read(id, ticket, "browserHash")).value);
    },
    async select(id: string, ticket: string, origin: string) {
      const login = await read(id, ticket, "browserHash");
      const platformUrl = discoveredPlatformUrl.parse(origin);

      if (login.value.platformUrl) {
        if (login.value.platformUrl !== platformUrl)
          throw new APIError("CONFLICT", { message: "This login already has a destination" });

        return inspect(login.value);
      }

      const value = { ...login.value, platformUrl };
      await save(login, value);

      return inspect(value);
    },
    async poll(id: string, cliToken: string) {
      return { platform_url: (await read(id, cliToken, "cliHash")).value.platformUrl };
    },
    async ready(id: string, cliToken: string, code: string) {
      const login = await read(id, cliToken, "cliHash");

      if (!login.value.platformUrl)
        throw new APIError("CONFLICT", { message: "Select an installation first" });
      const parsed = userCode.parse(code);

      if (login.value.userCode && login.value.userCode !== parsed)
        throw new APIError("CONFLICT", { message: "This login already has a device code" });

      if (!login.value.userCode) await save(login, { ...login.value, userCode: parsed });

      return { success: true };
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
    startCliLogin: createAuthEndpoint("/cli-login/start", { method: "POST" }, async (context) => {
      context.setHeader("cache-control", "no-store");

      return context.json(await login.start());
    }),
    pollCliLogin: createAuthEndpoint(
      "/cli-login/poll",
      { method: "POST", body: credentials },
      async (context) => {
        context.setHeader("cache-control", "no-store");

        return context.json(await login.poll(context.body.request_id, context.body.cli_token));
      },
    ),
    readyCliLogin: createAuthEndpoint(
      "/cli-login/ready",
      { method: "POST", body: credentials.extend({ user_code: userCode }) },
      async (context) => {
        context.setHeader("cache-control", "no-store");

        return context.json(
          await login.ready(
            context.body.request_id,
            context.body.cli_token,
            context.body.user_code,
          ),
        );
      },
    ),
  },
});
