import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { z } from "zod";
import { encryptSecrets, decryptSecrets } from "./secrets.ts";
import {
  workloadKeyGrace,
  workloadLifetime,
  workloadRotationInterval,
} from "./workload-protocol.ts";
import type { ParentEnvironment } from "./types.ts";

const path = "workload/signing-keys.json";

const publicKey = z.strictObject({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().min(1),
});

const privateKey = publicKey.extend({ d: z.string().min(1) });

const signingKey = z.strictObject({
  kid: z.string().min(1),
  activatesAt: z.number().int(),
  publicKey,
  privateKey: privateKey.optional(),
});

const keyRing = z.strictObject({ keys: z.array(signingKey).min(2).max(3) });

type Environment = Pick<ParentEnvironment, "WIDEFLEET_SECRETS_KEY"> & {
  WIDEFLEET_PACKAGES: {
    get(path: string): Promise<{ etag: string; text(): Promise<string> } | null>;
    put(
      path: string,
      value: string,
      options: { onlyIf: { etagMatches: string } | { etagDoesNotMatch: string } },
    ): Promise<{ etag: string } | null>;
  };
};

const generate = async (activatesAt: number) => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  const exported = publicKey.parse(await exportJWK(pair.publicKey));

  return {
    kid: await calculateJwkThumbprint(exported),
    activatesAt,
    publicKey: exported,
    privateKey: privateKey.parse(await exportJWK(pair.privateKey)),
  };
};

// The entire ring is one encrypted, conditionally-written object. All isolates
// and runtime restarts agree on one authority; losing a CAS never leaks a token
// signed by an unpublished key. No signing key is cached across requests.
export const workloadKeys = async (
  environment: Environment,
  now = Math.floor(Date.now() / 1000),
) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await environment.WIDEFLEET_PACKAGES.get(path);
    let ring;
    let changed = false;

    if (object) {
      const values = await decryptSecrets(environment, path, await object.text());
      ring = keyRing.parse(JSON.parse(z.string().parse(values["KEYRING"])));
    } else {
      ring = { keys: await Promise.all([generate(now), generate(now + workloadRotationInterval)]) };
      changed = true;
    }

    const current = ring.keys.filter((key) => key.activatesAt <= now).at(-1);

    if (!current?.privateKey) throw new Error("No active workload signing key");

    const retained = ring.keys.filter(
      (key) =>
        key.activatesAt >= current.activatesAt || now < current.activatesAt + workloadKeyGrace,
    );

    if (retained.length !== ring.keys.length) changed = true;
    ring.keys = retained.map((key) => {
      if (key.activatesAt >= current.activatesAt || !key.privateKey) return key;
      changed = true;

      return { kid: key.kid, activatesAt: key.activatesAt, publicKey: key.publicKey };
    });

    if (!ring.keys.some((key) => key.activatesAt > now)) {
      ring.keys.push(await generate(now + workloadRotationInterval));
      changed = true;
    }

    if (changed) {
      const ciphertext = await encryptSecrets(environment, path, { KEYRING: JSON.stringify(ring) });

      const result = await environment.WIDEFLEET_PACKAGES.put(path, ciphertext, {
        onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
      });

      if (!result) continue;
    }

    return {
      current,
      jwks: {
        keys: ring.keys.map((key) => ({
          ...key.publicKey,
          kid: key.kid,
          alg: "EdDSA",
          use: "sig",
        })),
      },
    };
  }

  throw new Error("Concurrent workload key update; retry the operation");
};

export const signWorkloadToken = async (
  environment: Environment,
  issuer: string,
  identity: { appId: string; organizationId: string },
  audience: string,
) => {
  const { current } = await workloadKeys(environment);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + workloadLifetime;

  const token = await new SignJWT({
    workload_type: "app",
    organization_id: identity.organizationId,
    app_id: identity.appId,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: current.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setSubject(`organization:${identity.organizationId}:app:${identity.appId}`)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .setJti(crypto.randomUUID())
    .sign(await importJWK(privateKey.parse(current.privateKey), "EdDSA"));

  return { token, expiresAt };
};
