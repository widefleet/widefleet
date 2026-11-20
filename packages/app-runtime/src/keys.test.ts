import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Each runtime isolate caches derived keys. A fresh module stands for a new isolate.
const isolate = async () => {
  vi.resetModules();

  return (await import("./keys.ts")).appKeys;
};

const first = "2a600000-0000-4000-8000-000000000001";

const second = "2a600000-0000-4000-8000-000000000002";

const stored = z.object({ version: z.number(), wrapped: z.string() });

const bucket = () => {
  const objects = new Map<string, string>();
  let writes = 0;

  const store = {
    objects,
    get writes() {
      return writes;
    },
    async get(key: string) {
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

const environment = (packages = bucket(), key = "ab".repeat(32)) => ({
  packages,
  // SAFETY: The tests use only the bucket methods the key store calls.
  environment: { WIDEFLEET_PACKAGES: packages as never, WIDEFLEET_SECRETS_KEY: key },
});

describe("app keys", () => {
  it("encrypts and decrypts without storing key material in plaintext", async () => {
    const appKeys = await isolate();
    const { packages, environment: env } = environment();
    const keys = appKeys(env, first);

    const ciphertext = await keys.encrypt("tokens", "provider-access");

    expect(ciphertext).toMatch(/^v1\./);
    expect(new TextDecoder().decode(await keys.decrypt("tokens", ciphertext))).toBe(
      "provider-access",
    );
    expect([...packages.objects.keys()]).toEqual([`app-keys/${first}/tokens.json`]);
    // A wrapped 32-byte key is 40 bytes, 54 base64url characters.
    expect(
      z
        .strictObject({ version: z.literal(1), wrapped: z.string().regex(/^[A-Za-z0-9_-]{54}$/) })
        .safeParse(JSON.parse(packages.objects.get(`app-keys/${first}/tokens.json`) ?? "")).success,
    ).toBe(true);
  });

  it("binds ciphertext to the app, the key name and the additional data", async () => {
    const appKeys = await isolate();
    const { environment: env } = environment();
    const ciphertext = await appKeys(env, first).encrypt("tokens", "secret", "account-1");

    await expect(appKeys(env, second).decrypt("tokens", ciphertext, "account-1")).rejects.toThrow(
      "App key ciphertext is invalid",
    );
    await expect(appKeys(env, first).decrypt("cookies", ciphertext, "account-1")).rejects.toThrow(
      "App key ciphertext is invalid",
    );
    await expect(appKeys(env, first).decrypt("tokens", ciphertext, "account-2")).rejects.toThrow(
      "App key ciphertext is invalid",
    );
    await expect(appKeys(env, first).decrypt("tokens", ciphertext)).rejects.toThrow(
      "App key ciphertext is invalid",
    );
  });

  it("rejects a wrapped key copied from another app", async () => {
    const appKeys = await isolate();
    const { packages, environment: env } = environment();
    await appKeys(env, first).encrypt("copied", "data");
    packages.objects.set(
      `app-keys/${second}/copied.json`,
      packages.objects.get(`app-keys/${first}/copied.json`) ?? "",
    );

    await expect(appKeys(env, second).encrypt("copied", "data")).rejects.toThrow();
  });

  it("keeps one key when first uses race in two isolates", async () => {
    const { packages, environment: env } = environment();
    const left = (await isolate())(env, first);
    const right = (await isolate())(env, first);

    const [fromLeft, fromRight] = await Promise.all([
      left.encrypt("race", "left"),
      right.encrypt("race", "right"),
    ]);

    expect(packages.writes).toBe(2);
    expect(packages.objects.size).toBe(1);
    expect(new TextDecoder().decode(await left.decrypt("race", fromRight))).toBe("right");
    expect(new TextDecoder().decode(await right.decrypt("race", fromLeft))).toBe("left");
  });

  it("reads keys that another isolate created", async () => {
    const { environment: env } = environment();
    const ciphertext = await (await isolate())(env, first).encrypt("shared", "value");

    expect(
      new TextDecoder().decode(await (await isolate())(env, first).decrypt("shared", ciphertext)),
    ).toBe("value");
  });

  it("cannot read keys under another installation key", async () => {
    const shared = bucket();

    const ciphertext = await (
      await isolate()
    )(environment(shared).environment, first).encrypt("installation", "value");

    await expect(
      (await isolate())(environment(shared, "cd".repeat(32)).environment, first).decrypt(
        "installation",
        ciphertext,
      ),
    ).rejects.toThrow();
  });

  it("signs and verifies data bound to the app and key name", async () => {
    const appKeys = await isolate();
    const { environment: env } = environment();
    const keys = appKeys(env, first);
    const signature = await keys.sign("cookies", "session-token");

    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await keys.verify("cookies", "session-token", signature)).toBe(true);
    expect(await keys.verify("cookies", "session-tokem", signature)).toBe(false);
    expect(await keys.verify("other", "session-token", signature)).toBe(false);
    expect(await appKeys(env, second).verify("cookies", "session-token", signature)).toBe(false);
    expect(await keys.verify("cookies", "session-token", "not base64!")).toBe(false);
  });

  it("rejects invalid key names before touching storage", async () => {
    const appKeys = await isolate();
    const { packages, environment: env } = environment();

    await expect(appKeys(env, first).encrypt("../other", "data")).rejects.toThrow(
      "Key names use 1–63 lowercase letters, digits and hyphens",
    );
    expect(packages.writes).toBe(0);
  });
});
