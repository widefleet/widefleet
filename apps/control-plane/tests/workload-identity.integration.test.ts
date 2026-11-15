import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { signWorkloadRequest, workloadToken } from "@platform/app-runtime/workload";
import { createWorkloadIdentity, workloadIssuer } from "../src/lib/server/workload-identity.ts";
import { createTestEnvironment } from "./environment.ts";
import { apps, organizationRuntimes } from "../src/lib/server/schema.ts";
import { jwks } from "../src/lib/server/auth-schema.ts";
import { verifyAccessToken } from "../src/lib/server/access-token.ts";

const secret = "synthetic-runtime-control-key-never-deploy";

const appId = crypto.randomUUID();

const audience = "https://data.example.test";

describe("Workload token issuance", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
    await environment.database.db.insert(apps).values({
      id: appId,
      slug: "data-service",
      displayName: "Data service",
      hostname: "data-service.apps.localhost",
      ownerId: environment.ownerId,
      organizationId: "widefleet",
      state: "active",
    });
  });
  afterAll(async () => {
    await environment.close();
  });

  const issuer = () => workloadIssuer(environment.configuration.PLATFORM_URL);

  const service = (allowed = true) =>
    createWorkloadIdentity(
      environment.auth,
      environment.database.db,
      environment.configuration.PLATFORM_URL,
      async () => secret,
      {
        filterOrganizations: async (candidates) => (allowed ? candidates.map(({ id }) => id) : []),
      },
    );

  const request = (body: string) => new Request(`${issuer()}/token`, { method: "POST", body });

  const proof = (organizationId = "widefleet", requestedAudience = audience, id = appId) =>
    signWorkloadRequest(secret, { appId: id, organizationId }, requestedAudience);

  const issue = async () => {
    const response = await service().issue(request(await proof()));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    return workloadToken.parse(await response.json());
  };

  it("issues a short-lived token verified with Better Auth's public keys without a user session", async () => {
    const { token, expiresAt } = await issue();
    const keys = await environment.auth.api.getJwks();

    const { payload } = await jwtVerify(token, createLocalJWKSet(keys), {
      issuer: issuer(),
      audience,
    });

    expect(payload).toMatchObject({
      sub: `organization:widefleet:app:${appId}`,
      workload_type: "app",
      organization_id: "widefleet",
      app_id: appId,
      exp: expiresAt,
    });
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(payload).not.toHaveProperty("scope");
    expect(payload).not.toHaveProperty("reference_id");
    await expect(
      jwtVerify(token, createLocalJWKSet(keys), { issuer: issuer(), audience: "other-api" }),
    ).rejects.toThrow();
    await expect(
      jwtVerify(token, createLocalJWKSet(keys), {
        issuer: issuer(),
        audience,
        currentDate: new Date((expiresAt + 1) * 1000),
      }),
    ).rejects.toThrow();
    await expect(verifyAccessToken(token, keys, environment.configuration)).rejects.toThrow();
  });

  it("accepts another audience without registration but does not turn the workload into a platform user", async () => {
    const platformAudience = `${environment.configuration.PLATFORM_URL}/api/v1`;
    const response = await service().issue(request(await proof("widefleet", platformAudience)));
    const { token } = workloadToken.parse(await response.json());
    const keys = await environment.auth.api.getJwks();
    await expect(verifyAccessToken(token, keys, environment.configuration)).rejects.toThrow();

    const { payload } = await jwtVerify(token, createLocalJWKSet(keys), {
      issuer: issuer(),
      audience: platformAudience,
    });

    expect(payload["app_id"]).toBe(appId);
  });

  it("rejects forged identities and ordinary user tokens as runtime credentials", async () => {
    const signed = await proof();
    const [body, signature] = signed.split(".");

    const altered = Buffer.from(
      Buffer.from(body!, "base64").toString().replace(appId, crypto.randomUUID()),
    ).toString("base64");

    expect((await service().issue(request(`${altered}.${signature}`))).status).toBe(401);
    expect((await service().issue(request(secret))).status).toBe(401);
    expect((await service().issue(request((await issue()).token))).status).toBe(401);

    const userToken = await environment.auth.api.signJWT({
      body: { payload: { sub: environment.ownerId, aud: audience } },
    });

    expect((await service().issue(request(userToken.token))).status).toBe(401);
    await expect(
      jwtVerify(userToken.token, createLocalJWKSet(await environment.auth.api.getJwks()), {
        issuer: issuer(),
        audience,
      }),
    ).rejects.toThrow();
    expect(
      (
        await service().issue(
          request(
            await signWorkloadRequest(
              "different-synthetic-runtime-key-123456",
              { appId, organizationId: "widefleet" },
              audience,
            ),
          ),
        )
      ).status,
    ).toBe(401);
  });

  it("checks app ownership, existence and organization admission on every issuance", async () => {
    expect((await service().issue(request(await proof("other-organization")))).status).toBe(403);
    expect(
      (await service().issue(request(await proof("widefleet", audience, crypto.randomUUID()))))
        .status,
    ).toBe(403);
    expect((await service(false).issue(request(await proof()))).status).toBe(403);
  });

  it("stops issuance for suspended organizations and deleting apps", async () => {
    await environment.database.db
      .update(organizationRuntimes)
      .set({ httpBlocked: true })
      .where(eq(organizationRuntimes.organizationId, "widefleet"));
    expect((await service().issue(request(await proof()))).status).toBe(403);
    await environment.database.db
      .update(organizationRuntimes)
      .set({ httpBlocked: false })
      .where(eq(organizationRuntimes.organizationId, "widefleet"));
    await environment.database.db.update(apps).set({ state: "deleting" }).where(eq(apps.id, appId));
    expect((await service().issue(request(await proof()))).status).toBe(403);
    await environment.database.db.update(apps).set({ state: "active" }).where(eq(apps.id, appId));
  });

  it("bounds unauthenticated request bodies", async () => {
    expect((await service().issue(request("a".repeat(8193)))).status).toBe(413);
    expect((await service().issue(request(""))).status).toBe(401);
  });

  it("enrolls legacy keys in rotation and retains verification of unexpired tokens", async () => {
    const first = await issue();
    const firstKid = decodeProtectedHeader(first.token).kid;
    await environment.database.db.update(jwks).set({ expiresAt: null });

    const migration = await readFile(
      new URL("../migrations/0031_signing_key_rotation.sql", import.meta.url),
      "utf8",
    );

    await environment.database.db.execute(sql.raw(migration));

    const [legacyKey] = await environment.database.db
      .select()
      .from(jwks)
      .where(eq(jwks.id, firstKid!));

    expect(legacyKey!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
    expect(decodeProtectedHeader((await issue()).token).kid).toBe(firstKid);
    await environment.database.db.update(jwks).set({ expiresAt: new Date(Date.now() - 1000) });
    const second = await issue();
    expect(decodeProtectedHeader(second.token).kid).not.toBe(firstKid);
    const keys = createLocalJWKSet(await environment.auth.api.getJwks());
    await jwtVerify(first.token, keys, { issuer: issuer(), audience });
    await jwtVerify(second.token, keys, { issuer: issuer(), audience });
  });
});
