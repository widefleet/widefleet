import { runtimeRekeyPage } from "@platform/contracts";
import { base64url, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openAppKey, parseAppKey } from "./keys.ts";
import { rekeyRuntimeStorage } from "./rekey.ts";
import { decryptText, encryptText } from "./secrets.ts";

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const appId = "2a600000-0000-4000-8000-000000000001";

const keyring = (...versions: [kid: string, byte: number][]) =>
  JSON.stringify({
    keys: versions.map(([kid, byte]) => ({
      kty: "oct",
      kid,
      k: base64url.encode(new Uint8Array(32).fill(byte)),
    })),
  });

const earlier = { WIDEFLEET_SECRETS_KEYS: keyring(["one", 1]) };

const rotated = { WIDEFLEET_SECRETS_KEYS: keyring(["two", 2], ["one", 1]) };

/** An R2 bucket in memory with ETags and conditional writes. */
const bucket = (
  hooks: { beforePut?: (key: string) => void; beforeGet?: (key: string) => void } = {},
) => {
  const objects = new Map<string, { value: string; etag: string }>();
  let version = 0;

  const write = (key: string, value: string) => {
    version += 1;
    objects.set(key, { value, etag: `etag-${version}` });
  };

  return {
    objects,
    write,
    async list({ prefix, limit, cursor }: { prefix: string; limit: number; cursor?: string }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;

      return {
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated && { cursor: String(start + limit) }),
      };
    },
    async get(key: string) {
      hooks.beforeGet?.(key);
      const object = objects.get(key);

      return object ? { etag: object.etag, text: async () => object.value } : null;
    },
    async put(key: string, value: Uint8Array, options: { onlyIf: { etagMatches: string } }) {
      hooks.beforePut?.(key);

      if (objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      write(key, decoder.decode(value));

      return {};
    },
  };
};

type Bucket = ReturnType<typeof bucket>;

const environment = (packages: Bucket, keys = rotated) => ({
  // SAFETY: The tests use only the bucket methods the rewrite calls.
  WIDEFLEET_PACKAGES: packages as never,
  ...keys,
});

/** Runs one complete pass, page by page, and sums its counts. */
const pass = async (packages: Bucket, keys = rotated) => {
  const total = { current: 0, rewritten: 0, unreadable: 0, conflicts: 0, pages: 0 };
  let cursor: string | null = null;

  do {
    const response = await rekeyRuntimeStorage(
      new Request("https://runtime.internal/.well-known/widefleet/rekey", {
        method: "POST",
        body: JSON.stringify(cursor ? { cursor } : {}),
      }),
      environment(packages, keys),
    );

    const page = z.object({ result: runtimeRekeyPage }).parse(await response.json()).result;

    total.current += page.current;
    total.rewritten += page.rewritten;
    total.unreadable += page.unreadable;
    total.conflicts += page.conflicts;
    total.pages += 1;
    cursor = page.cursor;
  } while (cursor);

  return total;
};

/** base64(iv || AES-GCM) under the raw bytes, as values were sealed before the runtime keyring. */
const sealedBeforeKeyring = async (byte: number, scope: string, text: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(scope) },
      await crypto.subtle.importKey("raw", new Uint8Array(32).fill(byte), "AES-GCM", false, [
        "encrypt",
      ]),
      encoder.encode(text),
    ),
  );

  return btoa(String.fromCharCode(...iv, ...sealed));
};

/** An app key record before the runtime keyring: AES-KW under HKDF(raw bytes, app ID). */
const appKeyBeforeKeyring = async (byte: number, material: Uint8Array<ArrayBuffer>) => {
  const wrapping = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encoder.encode(`widefleet app key wrapping v1\n${appId}`),
    },
    await crypto.subtle.importKey("raw", new Uint8Array(32).fill(byte), "HKDF", false, [
      "deriveKey",
    ]),
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey"],
  );

  const wrapped = await crypto.subtle.wrapKey(
    "raw",
    await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, true, [
      "sign",
    ]),
    wrapping,
    "AES-KW",
  );

  return JSON.stringify({ version: 1, wrapped: base64url.encode(new Uint8Array(wrapped)) });
};

const snapshot = (index: number) => `app-secrets/${appId}/${index}.json`;

const keyVersion = (value: string) => decodeProtectedHeader(value).kid;

const ciphertext = z.object({ ciphertext: z.string() });

describe("runtime storage rewrite", () => {
  it("seals every stored value again under the active key version without changing it", async () => {
    const packages = bucket();
    const material = crypto.getRandomValues(new Uint8Array(32));
    const appKey = `app-keys/${appId}/tokens.json`;
    const ring = "workload/signing-keys-rs256.json";
    const earlierRing = "workload/signing-keys.json";

    // Values before the keyring were sealed with the raw bytes of today's active version.
    // Snapshots from before fingerprints were removed still carry one.
    packages.write(
      snapshot(1),
      JSON.stringify({
        ciphertext: await sealedBeforeKeyring(2, snapshot(1), '{"A":"one"}'),
        fingerprint: "earlier-fingerprint",
      }),
    );
    packages.write(
      snapshot(2),
      JSON.stringify({ ciphertext: await encryptText(earlier, snapshot(2), '{"A":"two"}') }),
    );
    packages.write(
      snapshot(3),
      JSON.stringify({ ciphertext: await encryptText(rotated, snapshot(3), '{"A":"three"}') }),
    );
    packages.write(appKey, await appKeyBeforeKeyring(2, material));
    packages.write(ring, await encryptText(earlier, ring, '{"KEYRING":"ring"}'));
    packages.write(earlierRing, "an earlier ring that is no longer read");

    expect(await pass(packages)).toMatchObject({
      current: 1,
      rewritten: 4,
      unreadable: 0,
      conflicts: 0,
    });

    const stored = (key: string) => packages.objects.get(key)?.value ?? "";

    for (const index of [1, 2, 3])
      expect(keyVersion(ciphertext.parse(JSON.parse(stored(snapshot(index)))).ciphertext)).toBe(
        "two",
      );
    expect(
      await decryptText(
        rotated,
        snapshot(1),
        ciphertext.parse(JSON.parse(stored(snapshot(1)))).ciphertext,
      ),
    ).toBe('{"A":"one"}');
    expect(stored(snapshot(1))).not.toContain("fingerprint");
    expect(keyVersion(stored(ring))).toBe("two");
    expect(await decryptText(rotated, ring, stored(ring))).toBe('{"KEYRING":"ring"}');
    expect(keyVersion(ciphertext.parse(JSON.parse(stored(appKey))).ciphertext)).toBe("two");

    // The app key keeps its bytes, so its ciphertexts and signatures stay valid.
    expect(
      await openAppKey(environment(packages), appId, appKey, parseAppKey(stored(appKey))),
    ).toEqual(material);
    expect(stored(earlierRing)).toBe("an earlier ring that is no longer read");

    // A second pass finds nothing left, so the earlier version can be removed.
    expect(await pass(packages)).toMatchObject({
      current: 5,
      rewritten: 0,
      unreadable: 0,
      conflicts: 0,
    });
    expect(await pass(packages, { WIDEFLEET_SECRETS_KEYS: keyring(["two", 2]) })).toMatchObject({
      current: 5,
      rewritten: 0,
      unreadable: 0,
      conflicts: 0,
    });
  });

  it("counts values that no key version opens and leaves them unchanged", async () => {
    const packages = bucket();

    const unknown = await encryptText(
      { WIDEFLEET_SECRETS_KEYS: keyring(["other", 9]) },
      snapshot(1),
      "{}",
    );

    packages.write(snapshot(1), JSON.stringify({ ciphertext: unknown }));
    // A value moved to another object fails its context check.
    packages.write(
      snapshot(2),
      JSON.stringify({ ciphertext: await encryptText(earlier, snapshot(3), "{}") }),
    );
    packages.write(`app-keys/${appId}/nested/name.json`, "{}");

    expect(await pass(packages)).toMatchObject({ unreadable: 3, rewritten: 0 });
    expect(packages.objects.get(snapshot(1))?.value).toBe(JSON.stringify({ ciphertext: unknown }));
  });

  it("keeps a value written while the page rewrote it", async () => {
    let concurrent: string | undefined;

    const packages = bucket({
      beforePut: (key) => {
        if (concurrent && key === snapshot(1)) {
          packages.write(key, concurrent);
          concurrent = undefined;
        }
      },
    });

    packages.write(
      snapshot(1),
      JSON.stringify({ ciphertext: await encryptText(earlier, snapshot(1), '{"A":"old"}') }),
    );
    // A snapshot prepared again under the active version replaces it meanwhile.
    concurrent = JSON.stringify({
      ciphertext: await encryptText(rotated, snapshot(1), '{"A":"new"}'),
    });

    expect(await pass(packages)).toMatchObject({ current: 1, rewritten: 0, conflicts: 0 });
    expect(
      await decryptText(
        rotated,
        snapshot(1),
        ciphertext.parse(JSON.parse(packages.objects.get(snapshot(1))?.value ?? "")).ciphertext,
      ),
    ).toBe('{"A":"new"}');
  });

  it("leaves an object deleted meanwhile deleted", async () => {
    const packages = bucket({ beforeGet: (key) => packages.objects.delete(key) });

    packages.write(
      snapshot(1),
      JSON.stringify({ ciphertext: await encryptText(earlier, snapshot(1), "{}") }),
    );

    expect(await pass(packages)).toMatchObject({ current: 0, rewritten: 0, unreadable: 0 });
    expect(packages.objects.has(snapshot(1))).toBe(false);
  });

  it("continues a pass across pages", async () => {
    const packages = bucket();

    for (let index = 0; index < 120; index++)
      packages.write(
        snapshot(index),
        JSON.stringify({ ciphertext: await encryptText(earlier, snapshot(index), "{}") }),
      );

    const total = await pass(packages);

    expect(total).toMatchObject({ rewritten: 120, unreadable: 0, conflicts: 0 });
    expect(total.pages).toBeGreaterThan(3);
  });
});
