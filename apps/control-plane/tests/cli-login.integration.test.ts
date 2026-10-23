import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { verification } from "../src/lib/server/auth-schema.ts";
import { createTestEnvironment } from "./environment.ts";

const cloudOrigin = "https://app.widefleet.com";

const companyOrigin = "https://company.example.test";

describe("CLI discovery followed by Better Auth device authorization", () => {
  let cloud: Awaited<ReturnType<typeof createTestEnvironment>>;
  let company: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    cloud = await createTestEnvironment(cloudOrigin);
    company = await createTestEnvironment(companyOrigin);
  });
  afterAll(async () => {
    await cloud?.close();
    await company?.close();
  });

  const begin = async () => {
    const started = await cloud.cliLogin.start();
    const ticket = z.string().parse(new URL(started.verification_uri).searchParams.get("ticket"));

    return { ...started, ticket };
  };

  it.each(["company", "cloud"])(
    "uses the selected %s's standard device grant and keeps credentials out of routing",
    async (destination) => {
      const target = destination === "cloud" ? cloud : company;
      const started = await begin();
      expect(await cloud.cliLogin.poll(started.request_id, started.cli_token)).toEqual({
        platform_url: null,
      });
      await cloud.cliLogin.select(
        started.request_id,
        started.ticket,
        target.configuration.PLATFORM_URL,
      );
      const selected = await cloud.cliLogin.poll(started.request_id, started.cli_token);
      expect(selected).toEqual({ platform_url: target.configuration.PLATFORM_URL });

      const created = await target.auth.handler(
        new Request(`${selected.platform_url}/api/auth/device/code`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "platform-cli",
            scope: "openid offline_access platform:read platform:write",
            resource: `${selected.platform_url}/api/v1`,
          }),
        }),
      );

      expect(created.status).toBe(200);

      const device = z
        .object({ user_code: z.string(), device_code: z.string() })
        .parse(await created.json());

      await cloud.cliLogin.ready(started.request_id, started.cli_token, device.user_code);
      const browser = await cloud.cliLogin.inspect(started.request_id, started.ticket);
      expect(new URL(z.string().parse(browser.verificationUri)).origin).toBe(selected.platform_url);
      const credential = await target.users.login({ userId: target.ownerId });

      const claimed = await target.auth.handler(
        new Request(
          `${selected.platform_url}/api/auth/device?user_code=${encodeURIComponent(device.user_code)}`,
          { headers: credential.headers },
        ),
      );

      expect(claimed.status).toBe(200);

      const approved = await target.auth.handler(
        new Request(`${selected.platform_url}/api/auth/device/approve`, {
          method: "POST",
          headers: {
            ...Object.fromEntries(credential.headers),
            origin: target.configuration.PLATFORM_URL,
            "content-type": "application/json",
          },
          body: JSON.stringify({ userCode: device.user_code }),
        }),
      );

      expect(approved.status, await approved.clone().text()).toBe(200);

      const exchanged = await target.auth.handler(
        new Request(`${selected.platform_url}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "platform-cli",
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.device_code,
          }),
        }),
      );

      expect(exchanged.status, await exchanged.clone().text()).toBe(200);

      const tokens = z
        .object({ access_token: z.string(), refresh_token: z.string() })
        .parse(await exchanged.json());

      const [row] = await cloud.database.db
        .select()
        .from(verification)
        .where(eq(verification.id, `cli-routing:${started.request_id}`));

      for (const value of [
        device.device_code,
        tokens.access_token,
        tokens.refresh_token,
        started.ticket,
        started.cli_token,
      ])
        expect(row?.value).not.toContain(value);
    },
  );

  it("separates browser and CLI secrets and rejects cross-request credentials", async () => {
    const first = await begin();
    const second = await begin();
    await expect(cloud.cliLogin.poll(first.request_id, first.ticket)).rejects.toThrow(
      "Invalid CLI",
    );
    await expect(cloud.cliLogin.inspect(first.request_id, first.cli_token)).rejects.toThrow(
      "Invalid CLI",
    );
    await expect(cloud.cliLogin.ready(first.request_id, second.cli_token, "CODE")).rejects.toThrow(
      "Invalid CLI",
    );
    await expect(
      cloud.cliLogin.select(first.request_id, second.ticket, companyOrigin),
    ).rejects.toThrow("Invalid CLI");
  });

  it("pins the selected origin and public device code", async () => {
    const started = await begin();
    await expect(
      cloud.cliLogin.ready(started.request_id, started.cli_token, "CODE"),
    ).rejects.toThrow("Select an installation");
    await cloud.cliLogin.select(started.request_id, started.ticket, companyOrigin);
    await cloud.cliLogin.select(started.request_id, started.ticket, companyOrigin);
    await expect(
      cloud.cliLogin.select(started.request_id, started.ticket, cloudOrigin),
    ).rejects.toThrow("already has a destination");
    await cloud.cliLogin.ready(started.request_id, started.cli_token, "TEST-CODE");
    await cloud.cliLogin.ready(started.request_id, started.cli_token, "TEST-CODE");
    await expect(
      cloud.cliLogin.ready(started.request_id, started.cli_token, "OTHER"),
    ).rejects.toThrow("already has a device code");
    expect((await cloud.cliLogin.inspect(started.request_id, started.ticket)).verificationUri).toBe(
      `${companyOrigin}/device?user_code=TEST-CODE`,
    );
  });

  it("allows only one of two concurrently selected destinations", async () => {
    const started = await begin();

    const results = await Promise.allSettled(
      [cloudOrigin, companyOrigin].map((origin) =>
        cloud.cliLogin.select(started.request_id, started.ticket, origin),
      ),
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  });

  it("expires routing requests and does not enable routing on selfhosts", async () => {
    const started = await begin();
    await cloud.database.db
      .update(verification)
      .set({ expiresAt: new Date(0) })
      .where(eq(verification.id, `cli-routing:${started.request_id}`));
    await expect(cloud.cliLogin.poll(started.request_id, started.cli_token)).rejects.toThrow(
      "expired",
    );
    await expect(cloud.cliLogin.inspect(started.request_id, started.ticket)).rejects.toThrow(
      "expired",
    );
    await expect(company.cliLogin.start()).rejects.toThrow();
  });
});
