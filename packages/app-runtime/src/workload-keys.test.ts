import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { signWorkloadToken, workloadKeys } from "./workload-keys.ts";
import { workloadKeyGrace, workloadRotationInterval } from "./workload-protocol.ts";
import { encryptSecrets } from "./secrets.ts";
import { testKeyring } from "../fixtures/keyring.ts";

let runtime: Miniflare;

let directory: string;

const issuer = "https://auth.apps.example.test/workload";

const identity = { appId: crypto.randomUUID(), organizationId: "example" };

const start = () =>
  new Miniflare({
    telemetry: { enabled: false },
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          name: "keys",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default {fetch(){return new Response('ok')}}",
              },
            },
          },
          env: { PACKAGES: { type: "r2", name: "packages" } },
        },
      },
    ],
  });

const environment = async () => ({
  WIDEFLEET_PACKAGES: await runtime.getR2Bucket("PACKAGES"),
  WIDEFLEET_SECRETS_KEYS: testKeyring(),
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "widefleet-workload-keys-"));
  runtime = start();
  await runtime.ready;
});

afterEach(async () => {
  vi.useRealTimers();
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
});

it("persists one encrypted authority across concurrent initialization and cold restarts", async () => {
  const env = await environment();

  const tokens = await Promise.all(
    Array.from({ length: 8 }, () => signWorkloadToken(env, issuer, identity, "data")),
  );

  const { jwks } = await workloadKeys(env);
  expect(new Set(tokens.map(({ token }) => decodeProtectedHeader(token).kid)).size).toBe(1);

  for (const { token } of tokens)
    await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer,
      audience: "data",
      algorithms: ["RS256"],
    });
  const stored = await env.WIDEFLEET_PACKAGES.get("workload/signing-keys-rs256.json");
  expect(await stored!.text()).not.toContain('"privateKey"');
  expect(JSON.stringify(jwks)).not.toContain('"d"');
  await runtime.dispose();
  runtime = start();
  const after = await workloadKeys(await environment());
  expect(after.jwks).toEqual(jwks);
  const token = await signWorkloadToken(await environment(), issuer, identity, "data");
  await jwtVerify(token.token, createLocalJWKSet(jwks), {
    issuer,
    audience: "data",
    algorithms: ["RS256"],
  });
});

it("prepublishes the next key, rotates offline, and keeps old verification keys through token expiry", async () => {
  const env = await environment();
  vi.useFakeTimers({ toFake: ["Date"] });
  const startTime = 1_800_000_000;
  vi.setSystemTime(startTime * 1000);
  const original = await workloadKeys(env);
  vi.setSystemTime((startTime + workloadRotationInterval - 60) * 1000);
  const oldToken = await signWorkloadToken(env, issuer, identity, "data");
  vi.setSystemTime((startTime + workloadRotationInterval) * 1000);
  const newToken = await signWorkloadToken(env, issuer, identity, "data");
  expect(decodeProtectedHeader(newToken.token).kid).not.toBe(
    decodeProtectedHeader(oldToken.token).kid,
  );

  // Even a receiver that has not refreshed its original JWKS knows the next key.
  for (const { token } of [oldToken, newToken])
    await jwtVerify(token, createLocalJWKSet(original.jwks), {
      issuer,
      audience: "data",
      algorithms: ["RS256"],
    });
  const rotated = await workloadKeys(env);
  expect(rotated.jwks.keys).toHaveLength(3);
  vi.setSystemTime((startTime + workloadRotationInterval + workloadKeyGrace + 1) * 1000);
  const retired = await workloadKeys(env);
  expect(retired.jwks.keys).toHaveLength(2);
  expect(
    retired.jwks.keys.some((key) => key.kid === decodeProtectedHeader(oldToken.token).kid),
  ).toBe(false);
  await expect(
    jwtVerify(oldToken.token, createLocalJWKSet(original.jwks), {
      issuer,
      audience: "data",
      algorithms: ["RS256"],
    }),
  ).rejects.toThrow();
});

it("signs with the next key when another call created or rotated the ring a moment later", async () => {
  const env = await environment();
  const startTime = 1_800_000_000;
  const created = await workloadKeys(env, startTime);

  expect((await workloadKeys(env, startTime - 1)).current.kid).toBe(created.current.kid);

  const boundary = startTime + workloadRotationInterval;
  const rotated = await workloadKeys(env, boundary);

  expect(rotated.current.kid).not.toBe(created.current.kid);
  expect((await workloadKeys(env, boundary - 1)).current.kid).toBe(rotated.current.kid);
  expect(created.jwks.keys.map((key) => key.kid)).toContain(rotated.current.kid);
});

it("refuses issuance with the wrong encryption key without replacing the stored authority", async () => {
  const env = await environment();
  const original = await workloadKeys(env);
  const wrongKey = { ...env, WIDEFLEET_SECRETS_KEYS: testKeyring(["test", 0xcd]) };
  await expect(signWorkloadToken(wrongKey, issuer, identity, "data")).rejects.toThrow();
  expect((await workloadKeys(env)).jwks).toEqual(original.jwks);
});

it("starts an independent RSA authority without changing a persisted Ed25519 ring", async () => {
  const env = await environment();
  const legacyPath = "workload/signing-keys.json";
  const legacyKey = await generateKeyPair("EdDSA", { extractable: true });
  const now = Math.floor(Date.now() / 1000);

  const legacyRing = {
    keys: [now, now + workloadRotationInterval].map((activatesAt) => ({
      kid: "legacy-key",
      activatesAt,
    })),
  };

  const legacyPublicKey = await exportJWK(legacyKey.publicKey);
  const legacyPrivateKey = await exportJWK(legacyKey.privateKey);

  const ciphertext = await encryptSecrets(env, "workload-keys", legacyPath, {
    KEYRING: JSON.stringify({
      keys: legacyRing.keys.map((key) => ({
        ...key,
        publicKey: legacyPublicKey,
        privateKey: legacyPrivateKey,
      })),
    }),
  });

  await env.WIDEFLEET_PACKAGES.put(legacyPath, ciphertext);

  const { token } = await signWorkloadToken(env, issuer, identity, "data");
  const { jwks } = await workloadKeys(env);
  await jwtVerify(token, createLocalJWKSet(jwks), {
    issuer,
    audience: "data",
    algorithms: ["RS256"],
  });
  expect(jwks.keys.every((key) => key.kty === "RSA" && key.alg === "RS256")).toBe(true);
  expect(await (await env.WIDEFLEET_PACKAGES.get(legacyPath))!.text()).toBe(ciphertext);
});
