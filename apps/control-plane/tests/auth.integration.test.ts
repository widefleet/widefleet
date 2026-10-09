import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { apiResource, cliClientId } from "../src/lib/server/auth-options.ts";
import { registerCli } from "../src/lib/server/auth.ts";
import { deviceCode, oauthClient, user } from "../src/lib/server/auth-schema.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createTestEnvironment } from "./environment.ts";

const deviceResponse = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.url(),
});

const tokensResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

describe("OAuth device authorization against PostgreSQL", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => {
    await environment.close();
  });

  const request = (path: string, body: URLSearchParams, headers = new Headers()) => {
    headers.set("content-type", "application/x-www-form-urlencoded");

    return environment.auth.handler(
      new Request(`${environment.configuration.PLATFORM_URL}/api/auth${path}`, {
        method: "POST",
        headers,
        body,
      }),
    );
  };

  const start = async (scope = "openid offline_access platform:read platform:write") => {
    const response = await request(
      "/device/code",
      new URLSearchParams({
        client_id: cliClientId,
        scope,
        resource: apiResource(environment.configuration),
      }),
    );

    expect(response.status).toBe(200);

    return deviceResponse.parse(await response.json());
  };

  const login = async () => {
    const record = environment.users.createUser({ email: `${crypto.randomUUID()}@example.test` });
    await environment.users.saveUser(record);
    await environment.linkMicrosoftUser(record.id, environment.ownerSubject);

    return environment.users.login({ userId: record.id });
  };

  const claim = (code: string, headers: Headers) =>
    environment.auth.handler(
      new Request(`${environment.configuration.PLATFORM_URL}/api/auth/device?user_code=${code}`, {
        headers,
      }),
    );

  const decide = (decision: "approve" | "deny", code: string, headers: Headers) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");

    return environment.auth.handler(
      new Request(`${environment.configuration.PLATFORM_URL}/api/auth/device/${decision}`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ userCode: code }),
      }),
    );
  };

  it("updates the existing installation client to advertise new scopes without creating another login", async () => {
    await environment.database.db
      .update(oauthClient)
      .set({ scopes: ["platform:read"] })
      .where(eq(oauthClient.clientId, cliClientId));
    await registerCli(environment.auth, environment.database.db, environment.configuration);

    const clients = await environment.database.db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, cliClientId));

    expect(clients).toHaveLength(1);
    expect(clients[0]?.scopes).toContain("network:manage");
    await start("openid offline_access platform:read network:manage");
  });

  it("requires a registered client and rejects unapproved resources", async () => {
    const unknown = await request("/device/code", new URLSearchParams({ client_id: "unknown" }));
    expect(unknown.status).toBeGreaterThanOrEqual(400);

    const otherResource = await request(
      "/device/code",
      new URLSearchParams({
        client_id: cliClientId,
        scope: "platform:read",
        resource: "https://other.example.test",
      }),
    );

    expect(otherResource.status).toBeGreaterThanOrEqual(400);
  });

  it.each([false, true])(
    "accepts a read-only device token only when issued for the API resource: %s",
    async (includeResource) => {
      const parameters = new URLSearchParams({ client_id: cliClientId, scope: "platform:read" });

      if (includeResource) parameters.set("resource", apiResource(environment.configuration));
      const started = await request("/device/code", parameters);
      expect(started.status).toBe(200);
      const device = deviceResponse.parse(await started.json());
      const session = await login();
      const headers = new Headers(session.headers);
      headers.set("origin", environment.configuration.PLATFORM_URL);
      expect((await claim(device.user_code, headers)).status).toBe(200);
      expect((await decide("approve", device.user_code, headers)).status).toBe(200);

      const exchanged = await request(
        "/oauth2/token",
        new URLSearchParams({
          client_id: cliClientId,
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: device.device_code,
        }),
      );

      expect(exchanged.status).toBe(200);
      const tokens = tokensResponse.partial({ refresh_token: true }).parse(await exchanged.json());
      expect(tokens.refresh_token).toBeUndefined();
      expect(tokens.expires_in).toBeGreaterThan(0);

      const identity = createIdentityService(
        environment.auth,
        environment.database.db,
        environment.configuration,
      );

      const result = await identity.authenticate(
        new Request(`${apiResource(environment.configuration)}/me`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
        "platform:read",
      );

      expect(result.isOk()).toBe(includeResource);

      if (!includeResource)
        expect(result).toMatchObject({
          error: { code: "UNAUTHORIZED", message: "Invalid or expired access token" },
        });
    },
  );

  it.each([
    "platform:read platform:write",
    "platform:read network:manage",
    "platform:read platform:write network:manage",
  ])("requires approval and preserves combined scopes through refresh: %s", async (scopes) => {
    const device = await start(`openid offline_access ${scopes}`);

    const body = new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      client_id: cliClientId,
      device_code: device.device_code,
    });

    const pending = await request("/oauth2/token", body);
    expect(await pending.json()).toMatchObject({ error: "authorization_pending" });

    const session = await login();
    const headers = new Headers(session.headers);
    headers.set("origin", environment.configuration.PLATFORM_URL);
    expect((await claim(device.user_code, headers)).status).toBe(200);
    const approved = await decide("approve", device.user_code, headers);
    expect(approved.status).toBe(200);

    // Advance the persisted polling timestamp, preserving the real rate-limit implementation.
    await environment.database.db
      .update(deviceCode)
      .set({ lastPolledAt: new Date(0) })
      .where(eq(deviceCode.userCode, device.user_code));
    const response = await request("/oauth2/token", body);
    expect(response.status).toBe(200);
    const tokens = tokensResponse.parse(await response.json());
    expect(tokens.expires_in).toBeLessThanOrEqual(300);

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
    );

    const result = await identity.authenticate(
      new Request(`${apiResource(environment.configuration)}/apps`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
      "platform:write",
    );

    expect(result.isOk()).toBe(scopes.includes("platform:write"));
    expect(
      (
        await identity.authenticate(
          new Request(apiResource(environment.configuration), {
            headers: { authorization: `Bearer ${tokens.access_token}` },
          }),
          "network:manage",
        )
      ).isOk(),
    ).toBe(scopes.includes("network:manage"));

    const replay = await request("/oauth2/token", body);
    expect(replay.status).toBeGreaterThanOrEqual(400);

    const refreshed = await request(
      "/oauth2/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cliClientId,
        refresh_token: tokens.refresh_token,
      }),
    );

    expect(refreshed.status).toBe(200);
    const renewed = tokensResponse.parse(await refreshed.json());
    expect(renewed.refresh_token).not.toBe(tokens.refresh_token);
    expect(
      (
        await identity.authenticate(
          new Request(apiResource(environment.configuration), {
            headers: { authorization: `Bearer ${renewed.access_token}` },
          }),
          "network:manage",
        )
      ).isOk(),
    ).toBe(scopes.includes("network:manage"));
    expect(
      (
        await request(
          "/oauth2/revoke",
          new URLSearchParams({
            client_id: cliClientId,
            token: renewed.refresh_token,
            token_type_hint: "refresh_token",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          "/oauth2/token",
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: cliClientId,
            refresh_token: renewed.refresh_token,
          }),
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("binds approval to the session that claimed the code and respects denial", async () => {
    const device = await start();
    const first = await login();
    const second = await login();
    const headers = new Headers(first.headers);
    headers.set("origin", environment.configuration.PLATFORM_URL);
    expect((await claim(device.user_code, headers)).status).toBe(200);
    const other = new Headers(second.headers);
    other.set("origin", environment.configuration.PLATFORM_URL);
    expect((await decide("approve", device.user_code, other)).status).toBe(403);
    expect((await decide("deny", device.user_code, headers)).status).toBe(200);

    const denied = await request(
      "/oauth2/token",
      new URLSearchParams({
        client_id: cliClientId,
        device_code: device.device_code,
        grant_type: DEVICE_CODE_GRANT_TYPE,
      }),
    );

    expect(await denied.json()).toMatchObject({ error: "access_denied" });
  });

  it("rejects cross-origin writes and treats a session token as invalid OAuth input", async () => {
    const session = await login();

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
    );

    const headers = new Headers(session.headers);
    headers.set("origin", "https://other.example.test");
    expect(
      (
        await identity.authenticate(
          new Request(apiResource(environment.configuration), { headers }),
          "platform:write",
        )
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await identity.authenticate(
          new Request(apiResource(environment.configuration), {
            headers: { authorization: `Bearer ${session.token}` },
          }),
          "platform:read",
        )
      ).isErr(),
    ).toBe(true);
  });

  it("checks audience, issuer, expiry, scope and current identity independently", async () => {
    const session = await login();

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
    );

    const now = Math.floor(Date.now() / 1000);

    const claims = {
      sub: session.user.id,
      aud: apiResource(environment.configuration),
      iss: `${environment.configuration.PLATFORM_URL}/api/auth`,
      iat: now,
      exp: now + 300,
      scope: "platform:read",
    };

    const check = async (
      token: string,
      scope: "platform:read" | "platform:write" = "platform:read",
    ) =>
      identity.authenticate(
        new Request(apiResource(environment.configuration), {
          headers: { authorization: `Bearer ${token}` },
        }),
        scope,
      );

    for (const invalid of [
      { ...claims, aud: "https://other.example.test" },
      { ...claims, iss: "https://other.example.test" },
      { ...claims, exp: now - 60 },
    ]) {
      const { token } = await environment.auth.api.signJWT({ body: { payload: invalid } });
      expect(await check(token)).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    }

    const { token } = await environment.auth.api.signJWT({ body: { payload: claims } });
    expect((await check(token)).isOk()).toBe(true);
    expect(await check(token, "platform:write")).toMatchObject({ error: { code: "FORBIDDEN" } });
    await environment.database.db.delete(user).where(eq(user.id, session.user.id));
    expect(await check(token)).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});
