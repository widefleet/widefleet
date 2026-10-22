import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformProxy } from "wrangler";
import { z } from "zod";
import { createAuthentication } from "../src/lib/server/auth.ts";
import {
  cloudflareAuthRateLimit,
  type CloudflareAuthRateLimitBindings,
} from "../src/lib/server/auth-rate-limit-cloudflare.ts";
import type { EmailMessage } from "../src/lib/server/email.ts";
import { createTestEnvironment } from "./environment.ts";
import { expectRateLimitedBurst } from "./rate-limit.ts";

describe.each(["memory", "cloudflare"] as const)("Authentication rate limits: %s", (backend) => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let platform: PlatformProxy<CloudflareAuthRateLimitBindings> | undefined;
  let directory: string | undefined;
  const delivered: EmailMessage[] = [];

  beforeAll(async () => {
    environment = await createTestEnvironment();

    if (backend === "cloudflare") {
      const { getPlatformProxy, unstable_readConfig } = await import("wrangler");

      const configuration = z
        .object({
          compatibility_date: z.string(),
          ratelimits: z.array(
            z.object({
              name: z.string(),
              namespace_id: z.string(),
              simple: z.object({ limit: z.number(), period: z.number() }),
            }),
          ),
        })
        .parse(
          unstable_readConfig({
            config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
          }),
        );

      directory = await mkdtemp(join(tmpdir(), "widefleet-auth-rate-limit-"));
      const configPath = join(directory, "wrangler.json");
      await writeFile(
        configPath,
        JSON.stringify({
          name: "widefleet-auth-rate-limit-test",
          compatibility_date: configuration.compatibility_date,
          ratelimits: configuration.ratelimits,
        }),
      );
      platform = await getPlatformProxy<CloudflareAuthRateLimitBindings>({
        configPath,
        persist: false,
        remoteBindings: false,
      });
    }
  }, 30_000);

  afterAll(async () => {
    await platform?.dispose();
    await environment?.close();

    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const authentication = () =>
    createAuthentication(
      { ...environment.configuration, LOCAL_PASSWORD_ENABLED: true },
      environment.database.db,
      {
        rateLimit: platform
          ? cloudflareAuthRateLimit(platform.env, environment.configuration.PLATFORM_URL)
          : { enabled: true },
        ipAddressHeaders: backend === "cloudflare" ? ["cf-connecting-ip"] : ["x-forwarded-for"],
        sendEmail: async (message) => {
          delivered.push(message);
        },
      },
    );

  const request = (path: string, body: Record<string, string>, ip: string) =>
    authentication().handler(
      new Request(`${environment.configuration.PLATFORM_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          origin: environment.configuration.PLATFORM_URL,
          "content-type": "application/json",
          "cf-connecting-ip": ip,
          "x-forwarded-for": backend === "cloudflare" ? crypto.randomUUID() : ip,
        },
        body: JSON.stringify(body),
      }),
    );

  it("limits password requests across auth instances without a rate-limit table", async () => {
    const tables = await environment.database.db.execute(
      sql`select to_regclass('public.rate_limit') as name`,
    );

    expect(tables.rows).toEqual([{ name: null }]);
    const body = { email: environment.owner.email, password: "incorrect-test-password" };
    const ip = backend === "memory" ? "192.0.2.100" : "192.0.2.101";

    const admitted = await expectRateLimitedBurst(() => request("/sign-in/email", body, ip), {
      max: 3,
      window: 10,
      clockAligned: backend === "cloudflare",
      admittedStatus: 401,
    });

    for (const response of admitted) {
      expect(await response.json()).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    }

    expect(
      (await request("/sign-in/email", body, backend === "memory" ? "192.0.2.110" : "192.0.2.111"))
        .status,
    ).toBe(401);
  });

  it("limits actual code deliveries independently from password requests", async () => {
    const body = { email: environment.owner.email, type: "sign-in" };
    const before = delivered.length;
    const ip = backend === "memory" ? "198.51.100.10" : "198.51.100.11";

    const admitted = await expectRateLimitedBurst(
      () => request("/email-otp/send-verification-otp", body, ip),
      {
        max: 3,
        window: 60,
        clockAligned: backend === "cloudflare",
        admittedStatus: 200,
      },
    );

    expect(delivered.length - before).toBe(admitted.length);
    expect(
      (
        await request(
          "/sign-in/email",
          {
            email: environment.owner.email,
            password: "incorrect-test-password",
          },
          ip,
        )
      ).status,
    ).toBe(401);
  });

  it("rejects an exhausted code even when every attempt uses a different IP", async () => {
    await authentication().api.sendVerificationOTP({
      body: { email: environment.owner.email, type: "sign-in" },
    });
    const code = delivered.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
    expect(code).toBeDefined();

    if (!code) throw new Error("Expected a captured sign-in code");
    const incorrect = code === "000000" ? "111111" : "000000";

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request(
        "/sign-in/email-otp",
        {
          email: environment.owner.email,
          otp: incorrect,
        },
        `203.0.113.${attempt + (backend === "memory" ? 10 : 20)}`,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_OTP" });
    }

    const response = await request(
      "/sign-in/email-otp",
      {
        email: environment.owner.email,
        otp: code,
      },
      backend === "memory" ? "203.0.113.30" : "203.0.113.31",
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
  });

  it("has a Cloudflare binding for every active plugin policy", async () => {
    if (!platform) {
      expect((await authentication().$context).rateLimit.storage).toBe("memory");

      return;
    }

    for (const plugin of authentication().options.plugins ?? []) {
      if (!("rateLimit" in plugin)) continue;

      for (const configured of plugin.rateLimit ?? []) {
        const rule = configured.pathMatcher("/device")
          ? cloudflareAuthRateLimit(platform.env, environment.configuration.PLATFORM_URL)
              .customRules["/device"]
          : configured;

        await expect(
          cloudflareAuthRateLimit(
            platform.env,
            environment.configuration.PLATFORM_URL,
          ).customStorage.consume(crypto.randomUUID(), rule),
        ).resolves.toEqual({ allowed: true, retryAfter: null });
      }
    }

    await expect(
      cloudflareAuthRateLimit({}, "https://platform.example.test").customStorage.consume(
        "fixture",
        { max: 3, window: 10 },
      ),
    ).rejects.toThrow("Missing Cloudflare authentication rate limit");
  });

  it("limits CLI code lookups through the configured request window", async () => {
    const ip = backend === "memory" ? "192.0.2.120" : "192.0.2.121";

    const lookup = () =>
      authentication().handler(
        new Request(`${environment.configuration.PLATFORM_URL}/api/auth/device?user_code=INVALID`, {
          headers: { "cf-connecting-ip": ip, "x-forwarded-for": ip },
        }),
      );

    const admitted = await expectRateLimitedBurst(lookup, {
      max: 5,
      window: backend === "memory" ? 1800 : 60,
      clockAligned: backend === "cloudflare",
      admittedStatus: 400,
    });

    for (const response of admitted) {
      expect(await response.json()).toMatchObject({
        error: "invalid_request",
        error_description: "Invalid user code",
      });
    }
  });
});
