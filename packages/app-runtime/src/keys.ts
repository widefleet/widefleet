import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";

// Apps use these keys through the binding and never receive key material. Each
// named key is 32 random bytes, stored only wrapped with AES-KW under a key
// derived from the installation key and the app ID, so another app's wrapping
// key fails AES-KW's integrity check. Purpose keys are derived from it with HKDF.

export const appKeyName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Key names use 1–63 lowercase letters, digits and hyphens");

type Environment = Pick<ParentEnvironment, "WIDEFLEET_PACKAGES" | "WIDEFLEET_SECRETS_KEY">;

export type KeyData = string | Uint8Array<ArrayBuffer>;

const storedKey = z.strictObject({ version: z.literal(1), wrapped: z.string() });

const ciphertextPrefix = "v1.";

const encoder = new TextEncoder();

// RPC delivers strings or byte arrays. Copy bytes so a caller cannot hand in a
// shared or later-mutated buffer.
const keyData = z.union([
  z.string().transform((value) => encoder.encode(value)),
  z.instanceof(Uint8Array).transform((value) => new Uint8Array(value)),
]);

const bytes = (data: KeyData) => keyData.parse(data);

const base64url = (data: Uint8Array<ArrayBuffer>) =>
  btoa(Array.from(data, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const unbase64url = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  );

const keyPath = (appId: string, name: string) => `app-keys/${appId}/${name}.json`;

const wrappingKey = async (environment: Environment, appId: string) =>
  crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encoder.encode(`widefleet app key wrapping v1\n${appId}`),
    },
    await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(environment.WIDEFLEET_SECRETS_KEY)
          .match(/../g) ?? [],
        (byte) => Number.parseInt(byte, 16),
      ),
      "HKDF",
      false,
      ["deriveKey"],
    ),
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );

export type KeyOwner = { appId: string; hostname: string };

const publishedHost = z.union([
  z.looseObject({ deleted: z.literal(true) }),
  z.looseObject({ appId: z.string() }),
]);

// Removal unpublishes an app before it deletes its keys. A request still running
// then must not create a key that the finished removal would leave behind.
const requirePublished = async (environment: Environment, owner: KeyOwner) => {
  const host = await environment.WIDEFLEET_PACKAGES.get(`hosts/${owner.hostname}.json`);
  const entry = host ? publishedHost.parse(await host.json()) : null;

  if (!entry || "deleted" in entry || entry.appId !== owner.appId)
    throw new Error("The app is not published");
};

// Two concurrent first uses must agree on one key: only one conditional write
// succeeds, and the other request reads the stored key.
const loadKey = async (environment: Environment, owner: KeyOwner, name: string) => {
  const { appId } = owner;
  const path = keyPath(appId, name);
  const kek = await wrappingKey(environment, appId);
  let stored = await environment.WIDEFLEET_PACKAGES.get(path);

  if (!stored) {
    await requirePublished(environment, owner);

    const material = await crypto.subtle.importKey(
      "raw",
      crypto.getRandomValues(new Uint8Array(32)),
      { name: "HMAC", hash: "SHA-256" },
      true,
      ["sign"],
    );

    const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", material, kek, "AES-KW"));

    await environment.WIDEFLEET_PACKAGES.put(
      path,
      JSON.stringify(storedKey.parse({ version: 1, wrapped: base64url(wrapped) })),
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
    stored = await environment.WIDEFLEET_PACKAGES.get(path);

    if (!stored) throw new Error("App key storage is unavailable");
  }

  return crypto.subtle.unwrapKey(
    "raw",
    unbase64url(storedKey.parse(await stored.json()).wrapped),
    kek,
    "AES-KW",
    "HKDF",
    false,
    ["deriveKey"],
  );
};

const purpose = (name: "encrypt" | "sign") => ({
  name: "HKDF",
  hash: "SHA-256",
  salt: new Uint8Array(),
  info: encoder.encode(`widefleet app key ${name} v1`),
});

// Derived keys for recently used app keys. Older entries are evicted and load
// again from storage, so apps that use many key names cannot grow it unbounded.
const cacheLimit = 1000;

const derived = new Map<string, Promise<{ encryption: CryptoKey; signing: CryptoKey }>>();

const appKey = (environment: Environment, owner: KeyOwner, name: string) => {
  appKeyName.parse(name);
  const id = `${owner.appId}/${name}`;
  let keys = derived.get(id);

  if (keys) {
    // Mark the entry as recently used.
    derived.delete(id);
    derived.set(id, keys);

    return keys;
  }

  keys = loadKey(environment, owner, name).then(async (base) => ({
    encryption: await crypto.subtle.deriveKey(
      purpose("encrypt"),
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    signing: await crypto.subtle.deriveKey(
      purpose("sign"),
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    ),
  }));
  // A failed load, such as an unavailable bucket, must not stay cached.
  keys.catch(() => derived.delete(id));
  derived.set(id, keys);

  for (const oldest of derived.keys()) {
    if (derived.size <= cacheLimit) break;
    derived.delete(oldest);
  }

  return keys;
};

// Ciphertext and signatures are bound to the app and key name, so they cannot
// be replayed under another app's key or another key of the same app.
const context = (appId: string, name: string, additionalData: KeyData = "") =>
  new Uint8Array([...encoder.encode(`${appId}\n${name}\n`), ...bytes(additionalData)]);

export const appKeys = (environment: Environment, owner: KeyOwner) => {
  const { appId } = owner;

  return {
    async encrypt(name: string, data: KeyData, additionalData?: KeyData) {
      const { encryption } = await appKey(environment, owner, name);
      const iv = crypto.getRandomValues(new Uint8Array(12));

      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: context(appId, name, additionalData) },
          encryption,
          bytes(data),
        ),
      );

      return `${ciphertextPrefix}${base64url(new Uint8Array([...iv, ...sealed]))}`;
    },

    async decrypt(name: string, ciphertext: string, additionalData?: KeyData) {
      if (!ciphertext.startsWith(ciphertextPrefix))
        throw new Error("Unsupported app key ciphertext");
      const { encryption } = await appKey(environment, owner, name);
      const sealed = unbase64url(ciphertext.slice(ciphertextPrefix.length));

      try {
        return new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: sealed.slice(0, 12),
              additionalData: context(appId, name, additionalData),
            },
            encryption,
            sealed.slice(12),
          ),
        );
      } catch {
        throw new Error("App key ciphertext is invalid");
      }
    },

    async sign(name: string, data: KeyData) {
      const { signing } = await appKey(environment, owner, name);

      return base64url(
        new Uint8Array(await crypto.subtle.sign("HMAC", signing, context(appId, name, data))),
      );
    },

    async verify(name: string, data: KeyData, signature: string) {
      const { signing } = await appKey(environment, owner, name);
      let decoded;

      try {
        decoded = unbase64url(signature);
      } catch {
        return false;
      }

      return crypto.subtle.verify("HMAC", signing, decoded, context(appId, name, data));
    },
  };
};
