import { runtimeRekeyPage } from "@platform/contracts";
import { decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAppKey } from "./keys.ts";
import { rekeyRuntimeStorage } from "./rekey.ts";
import { decryptText, encryptText, open, seal } from "./secrets.ts";
import { testKeyring } from "../fixtures/keyring.ts";

const decoder = new TextDecoder();

const appId = "2a600000-0000-4000-8000-000000000001";

const earlier = { WIDEFLEET_SECRETS_KEYS: testKeyring(["one", 1]) };

const rotated = { WIDEFLEET_SECRETS_KEYS: testKeyring(["two", 2], ["one", 1]) };

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

    packages.write(
      snapshot(1),
      JSON.stringify({
        ciphertext: await encryptText(earlier, "app-secrets", snapshot(1), '{"A":"one"}'),
      }),
    );
    packages.write(
      snapshot(2),
      JSON.stringify({
        ciphertext: await encryptText(rotated, "app-secrets", snapshot(2), '{"A":"two"}'),
      }),
    );
    packages.write(
      appKey,
      JSON.stringify({ ciphertext: await seal(earlier, "app-keys", appKey, material) }),
    );
    packages.write(ring, await encryptText(earlier, "workload-keys", ring, '{"KEYRING":"ring"}'));
    packages.write(earlierRing, "an earlier ring that is no longer read");

    expect(await pass(packages)).toMatchObject({
      current: 1,
      rewritten: 3,
      unreadable: 0,
      conflicts: 0,
    });

    const stored = (key: string) => packages.objects.get(key)?.value ?? "";

    for (const index of [1, 2])
      expect(keyVersion(ciphertext.parse(JSON.parse(stored(snapshot(index)))).ciphertext)).toBe(
        "two:app-secrets",
      );
    expect(
      await decryptText(
        rotated,
        "app-secrets",
        snapshot(1),
        ciphertext.parse(JSON.parse(stored(snapshot(1)))).ciphertext,
      ),
    ).toBe('{"A":"one"}');
    expect(keyVersion(stored(ring))).toBe("two:workload-keys");
    expect(await decryptText(rotated, "workload-keys", ring, stored(ring))).toBe(
      '{"KEYRING":"ring"}',
    );
    expect(keyVersion(ciphertext.parse(JSON.parse(stored(appKey))).ciphertext)).toBe(
      "two:app-keys",
    );

    // The app key keeps its bytes, so its ciphertexts and signatures stay valid.
    expect(await open(rotated, "app-keys", appKey, parseAppKey(stored(appKey)).ciphertext)).toEqual(
      material,
    );
    expect(stored(earlierRing)).toBe("an earlier ring that is no longer read");

    // A second pass finds nothing left, so the earlier version can be removed.
    expect(await pass(packages)).toMatchObject({
      current: 4,
      rewritten: 0,
      unreadable: 0,
      conflicts: 0,
    });
    expect(await pass(packages, { WIDEFLEET_SECRETS_KEYS: testKeyring(["two", 2]) })).toMatchObject(
      {
        current: 4,
        rewritten: 0,
        unreadable: 0,
        conflicts: 0,
      },
    );
  });

  it("counts values that no key version opens and leaves them unchanged", async () => {
    const packages = bucket();

    const unknown = await encryptText(
      { WIDEFLEET_SECRETS_KEYS: testKeyring(["other", 9]) },
      "app-secrets",
      snapshot(1),
      "{}",
    );

    packages.write(snapshot(1), JSON.stringify({ ciphertext: unknown }));
    // A value moved to another object fails its context check.
    packages.write(
      snapshot(2),
      JSON.stringify({ ciphertext: await encryptText(earlier, "app-secrets", snapshot(3), "{}") }),
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
      JSON.stringify({
        ciphertext: await encryptText(earlier, "app-secrets", snapshot(1), '{"A":"old"}'),
      }),
    );
    // A snapshot prepared again under the active version replaces it meanwhile.
    concurrent = JSON.stringify({
      ciphertext: await encryptText(rotated, "app-secrets", snapshot(1), '{"A":"new"}'),
    });

    expect(await pass(packages)).toMatchObject({ current: 0, rewritten: 0, conflicts: 1 });
    expect(
      await decryptText(
        rotated,
        "app-secrets",
        snapshot(1),
        ciphertext.parse(JSON.parse(packages.objects.get(snapshot(1))?.value ?? "")).ciphertext,
      ),
    ).toBe('{"A":"new"}');
  });

  it("leaves an object deleted meanwhile deleted", async () => {
    const packages = bucket({ beforeGet: (key) => packages.objects.delete(key) });

    packages.write(
      snapshot(1),
      JSON.stringify({ ciphertext: await encryptText(earlier, "app-secrets", snapshot(1), "{}") }),
    );

    expect(await pass(packages)).toMatchObject({ current: 0, rewritten: 0, unreadable: 0 });
    expect(packages.objects.has(snapshot(1))).toBe(false);
  });

  it("continues a pass across pages", async () => {
    const packages = bucket();

    for (let index = 0; index < 120; index++)
      packages.write(
        snapshot(index),
        JSON.stringify({
          ciphertext: await encryptText(earlier, "app-secrets", snapshot(index), "{}"),
        }),
      );

    const total = await pass(packages);

    expect(total).toMatchObject({ rewritten: 120, unreadable: 0, conflicts: 0 });
    expect(total.pages).toBeGreaterThan(3);
  });
});
