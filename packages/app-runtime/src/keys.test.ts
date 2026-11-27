import { decodeProtectedHeader } from "jose";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testKeyring } from "../fixtures/keyring.ts";
import { appKeyBeforeKeyring } from "../fixtures/legacy.ts";

// Each runtime isolate caches derived keys. A fresh module stands for a new isolate.
const isolate = async () => {
  vi.resetModules();

  return (await import("./keys.ts")).appKeys;
};

const first = "2a600000-0000-4000-8000-000000000001";

const second = "2a600000-0000-4000-8000-000000000002";

const stored = z.union([
  z.object({ ciphertext: z.string() }),
  z.object({ version: z.number(), wrapped: z.string() }),
  z.looseObject({ appId: z.string() }),
  z.looseObject({ deleted: z.literal(true) }),
]);

// Both test apps are published, as apps that use their keys are.
const bucket = () => {
  const objects = new Map<string, string>([
    [`hosts/first.example.test.json`, JSON.stringify({ appId: first })],
    [`hosts/second.example.test.json`, JSON.stringify({ appId: second })],
  ]);

  let writes = 0;
  let reads = 0;

  const store = {
    objects,
    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
    async get(key: string) {
      reads++;
      const value = objects.get(key);

      return value === undefined ? null : { json: async () => stored.parse(JSON.parse(value)) };
    },
    async put(key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
      writes++;

      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      objects.set(key, value);

      return {};
    },
  };

  return store;
};

const environment = (packages = bucket(), key = testKeyring()) => ({
  packages,
  // SAFETY: The tests use only the bucket methods the key store calls.
  environment: { WIDEFLEET_PACKAGES: packages as never, WIDEFLEET_SECRETS_KEYS: key },
});

describe("app keys", () => {
  it("encrypts and decrypts without storing key material in plaintext", async () => {
    const appKeys = await isolate();
    const { packages, environment: env } = environment();
    const keys = appKeys(env, { appId: first, hostname: "first.example.test" });

    const ciphertext = await keys.encrypt("tokens", "provider-access");

    expect(ciphertext).toMatch(/^v1\./);
    expect(new TextDecoder().decode(await keys.decrypt("tokens", ciphertext))).toBe(
      "provider-access",
    );
    expect([...packages.objects.keys()].filter((key) => key.startsWith("app-keys/"))).toEqual([
      `app-keys/${first}/tokens.json`,
    ]);

    // The key is sealed with the runtime keyring and bound to its path.
    const record = z
      .strictObject({ ciphertext: z.string() })
      .parse(JSON.parse(packages.objects.get(`app-keys/${first}/tokens.json`) ?? ""));

    expect(decodeProtectedHeader(record.ciphertext)).toEqual({
      alg: "dir",
      enc: "A256GCM",
      kid: "test",
      ctx: `app-keys/${first}/tokens.json`,
    });
  });

  it("uses the same key bytes from a record stored before the runtime keyring", async () => {
    const material = crypto.getRandomValues(new Uint8Array(32));
    const path = `app-keys/${first}/legacy.json`;

    const { packages, environment: env } = environment();
    const owner = { appId: first, hostname: "first.example.test" };

    // The earlier record, with the bytes of testKeyring().
    packages.objects.set(path, await appKeyBeforeKeyring(0xab, first, material));
    const earlier = await (await isolate())(env, owner).sign("legacy", "session-token");

    // The same bytes sealed with the runtime keyring sign the same way.
    const { sealAppKey } = await import("./keys.ts");
    packages.objects.set(path, await sealAppKey(env, path, material));

    expect(await (await isolate())(env, owner).sign("legacy", "session-token")).toBe(earlier);
  });

  it("binds ciphertext to the app, the key name and the additional data", async () => {
    const appKeys = await isolate();
    const { environment: env } = environment();

    const ciphertext = await appKeys(env, { appId: first, hostname: "first.example.test" }).encrypt(
      "tokens",
      "secret",
      "account-1",
    );

    await expect(
      appKeys(env, { appId: second, hostname: "second.example.test" }).decrypt(
        "tokens",
        ciphertext,
        "account-1",
      ),
    ).rejects.toThrow("App key ciphertext is invalid");
    await expect(
      appKeys(env, { appId: first, hostname: "first.example.test" }).decrypt(
        "cookies",
        ciphertext,
        "account-1",
      ),
    ).rejects.toThrow("App key ciphertext is invalid");
    await expect(
      appKeys(env, { appId: first, hostname: "first.example.test" }).decrypt(
        "tokens",
        ciphertext,
        "account-2",
      ),
    ).rejects.toThrow("App key ciphertext is invalid");
    await expect(
      appKeys(env, { appId: first, hostname: "first.example.test" }).decrypt("tokens", ciphertext),
    ).rejects.toThrow("App key ciphertext is invalid");
  });

  it("rejects a wrapped key copied from another app", async () => {
    const appKeys = await isolate();
    const { packages, environment: env } = environment();
    await appKeys(env, { appId: first, hostname: "first.example.test" }).encrypt("copied", "data");
    packages.objects.set(
      `app-keys/${second}/copied.json`,
      packages.objects.get(`app-keys/${first}/copied.json`) ?? "",
    );

    await expect(
      appKeys(env, { appId: second, hostname: "second.example.test" }).encrypt("copied", "data"),
    ).rejects.toThrow();
  });

  it("keeps one key when first uses race in two isolates", async () => {
    const { packages, environment: env } = environment();
    const left = (await isolate())(env, { appId: first, hostname: "first.example.test" });
    const right = (await isolate())(env, { appId: first, hostname: "first.example.test" });

    const [fromLeft, fromRight] = await Promise.all([
      left.encrypt("race", "left"),
      right.encrypt("race", "right"),
    ]);

    expect(packages.writes).toBe(2);
    expect([...packages.objects.keys()].filter((key) => key.startsWith("app-keys/"))).toHaveLength(
      1,
    );
    expect(new TextDecoder().decode(await left.decrypt("race", fromRight))).toBe("right");
    expect(new TextDecoder().decode(await right.decrypt("race", fromLeft))).toBe("left");
  });

  it("reads keys that another isolate created", async () => {
    const { environment: env } = environment();

    const ciphertext = await (
      await isolate()
    )(env, { appId: first, hostname: "first.example.test" }).encrypt("shared", "value");

    expect(
      new TextDecoder().decode(
        await (
          await isolate()
        )(env, { appId: first, hostname: "first.example.test" }).decrypt("shared", ciphertext),
      ),
    ).toBe("value");
  });

  it("cannot read keys under another installation key", async () => {
    const shared = bucket();

    const ciphertext = await (
      await isolate()
    )(environment(shared).environment, { appId: first, hostname: "first.example.test" }).encrypt(
      "installation",
      "value",
    );

    await expect(
      (await isolate())(environment(shared, testKeyring(["test", 0xcd])).environment, {
        appId: first,
        hostname: "first.example.test",
      }).decrypt("installation", ciphertext),
    ).rejects.toThrow();
  });

  it("signs and verifies data bound to the app and key name", async () => {
    const appKeys = await isolate();
    const { environment: env } = environment();
    const keys = appKeys(env, { appId: first, hostname: "first.example.test" });
    const signature = await keys.sign("cookies", "session-token");

    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await keys.verify("cookies", "session-token", signature)).toBe(true);
    expect(await keys.verify("cookies", "session-tokem", signature)).toBe(false);
    expect(await keys.verify("other", "session-token", signature)).toBe(false);
    expect(
      await appKeys(env, { appId: second, hostname: "second.example.test" }).verify(
        "cookies",
        "session-token",
        signature,
      ),
    ).toBe(false);
    expect(await keys.verify("cookies", "session-token", "not base64!")).toBe(false);
  });

  it("creates no keys for an app that is no longer published", async () => {
    const appKeys = await isolate();
    const { packages, environment: env } = environment();

    packages.objects.set(
      "hosts/first.example.test.json",
      JSON.stringify({ deleted: true, appId: first }),
    );

    await expect(
      appKeys(env, { appId: first, hostname: "first.example.test" }).encrypt("late", "data"),
    ).rejects.toThrow("The app is not published");
    await expect(
      appKeys(env, { appId: first, hostname: "other.example.test" }).encrypt("late", "data"),
    ).rejects.toThrow("The app is not published");
    expect([...packages.objects.keys()].some((key) => key.startsWith("app-keys/"))).toBe(false);
  });

  it("evicts the least recently used derived keys and loads them again", async () => {
    const appKeys = await isolate();
    const { packages, environment: env } = environment();
    const keys = appKeys(env, { appId: first, hostname: "first.example.test" });
    const ciphertext = await keys.encrypt("key-0", "value");

    for (let index = 1; index <= 1000; index++) await keys.sign(`key-${index}`, "data");
    const reads = packages.reads;

    expect(new TextDecoder().decode(await keys.decrypt("key-0", ciphertext))).toBe("value");
    expect(packages.reads).toBeGreaterThan(reads);

    const cached = packages.reads;

    await keys.sign("key-1000", "data");
    expect(packages.reads).toBe(cached);
  }, 60_000);

  it("rejects invalid key names before touching storage", async () => {
    const appKeys = await isolate();
    const { packages, environment: env } = environment();

    await expect(
      appKeys(env, { appId: first, hostname: "first.example.test" }).encrypt("../other", "data"),
    ).rejects.toThrow("Key names use 1–63 lowercase letters, digits and hyphens");
    expect(packages.writes).toBe(0);
  });
});
