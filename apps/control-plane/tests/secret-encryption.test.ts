import { createDecipheriv, randomBytes } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { CompactEncrypt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import {
  configuredSecretEncryption,
  createSecretEncryption,
  generateKeyVersion,
  parseKeyring,
} from "../src/lib/server/secret-encryption.ts";

const legacyKey = "synthetic-legacy-installation-key-for-tests";

const context = { kind: "directory-client-secret", organizationId: "widefleet" } as const;

// Synthetic key material: byte values 255 down to 224.
const fixtureKey = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA";

const fixture = () => parseKeyring(`fixture:${fixtureKey}`, "test");

const keyVersion = (id: string) => `${id}:${randomBytes(32).toString("base64")}`;

const unreadable = {
  code: "BAD_REQUEST",
  message: "Stored credentials could not be decrypted. Restore the installation encryption key.",
};

/** Decrypts a `dir`/`A256GCM` JWE with node:crypto alone, outside our code path. */
const decryptIndependently = (jwe: string, key: Buffer) => {
  const [header = "", encryptedKey, iv = "", ciphertext = "", tag = ""] = jwe.split(".");

  expect(encryptedKey).toBe("");

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(header, "ascii"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

// Temporary: remove with legacy-secret-migration.ts.
describe("legacy ciphertexts", () => {
  // Recorded from better-auth's symmetricEncrypt with the synthetic key above.
  const stored =
    "04170b74ec840be7258e5c66a39a6a3455ee568a0ea14a8df2866f47bf919593d5bf7849c95bf27ecb86c01f03052ca9329cab0882bbedc2";

  it("decrypts ciphertexts that earlier releases stored, but writes only JWE", async () => {
    const encryption = createSecretEncryption({ keyring: fixture(), legacyKey });

    expect(await encryption.decrypt(context, stored)).toBe("synthetic secret");
    expect(decodeProtectedHeader(await encryption.encrypt(context, "new"))).toMatchObject({
      kid: "fixture",
    });
  });

  it("asks for the installation key when the legacy key differs or is missing", async () => {
    const ciphertext = await symmetricEncrypt({ key: legacyKey, data: "value" });

    for (const other of ["another-synthetic-installation-key", undefined])
      await expect(
        createSecretEncryption({ keyring: fixture(), legacyKey: other }).decrypt(
          context,
          ciphertext,
        ),
      ).rejects.toMatchObject(unreadable);
  });
});

describe("JWE ciphertexts", () => {
  it("writes compact JWE with dir, A256GCM and the active version as kid", async () => {
    const encryption = createSecretEncryption({ keyring: fixture() });
    const ciphertext = await encryption.encrypt(context, "synthetic secret");

    expect(decodeProtectedHeader(ciphertext)).toEqual({
      alg: "dir",
      enc: "A256GCM",
      kid: "fixture",
    });
    expect(await encryption.encrypt(context, "synthetic secret")).not.toBe(ciphertext);
    expect(decryptIndependently(ciphertext, Buffer.from(fixtureKey, "base64url"))).toBe(
      "synthetic secret",
    );
  });

  it("decrypts a recorded JWE, which node:crypto also decrypts on its own", async () => {
    // Recorded with the synthetic fixture key; pins the stored format.
    const stored =
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwia2lkIjoiZml4dHVyZSJ9..ucd4hnDSdgKovoQQ.qb4Hy4BREL_wLfXrmEjyLQ.a1rQlNW7OqwgEOn6s6Y9qw";

    expect(decryptIndependently(stored, Buffer.from(fixtureKey, "base64url"))).toBe(
      "synthetic secret",
    );
    expect(await createSecretEncryption({ keyring: fixture() }).decrypt(context, stored)).toBe(
      "synthetic secret",
    );
  });

  it("encrypts with a new active version while earlier versions still decrypt", async () => {
    const previous = keyVersion("previous");
    const before = createSecretEncryption({ keyring: parseKeyring(previous, "test") });
    const old = await before.encrypt(context, "written before rotation");

    const after = createSecretEncryption({
      keyring: parseKeyring(`${keyVersion("current")}\n${previous}`, "test"),
    });

    const current = await after.encrypt(context, "written after rotation");

    expect(decodeProtectedHeader(current).kid).toBe("current");
    expect(await after.decrypt(context, old)).toBe("written before rotation");
    expect(await after.decrypt(context, current)).toBe("written after rotation");
    await expect(before.decrypt(context, current)).rejects.toMatchObject(unreadable);
  });

  it("rejects unknown key versions, other algorithms and altered ciphertexts", async () => {
    const encryption = createSecretEncryption({ keyring: fixture() });
    const ciphertext = await encryption.encrypt(context, "value");
    const material = Buffer.from(fixtureKey, "base64url");
    const plaintext = new TextEncoder().encode("value");
    const parts = ciphertext.split(".");
    const tag = parts[4] ?? "";

    const rejected = [
      // A kid the keyring does not hold.
      await new CompactEncrypt(plaintext)
        .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: "missing" })
        .encrypt(material),
      // A content encryption algorithm other than A256GCM.
      await new CompactEncrypt(plaintext)
        .setProtectedHeader({ alg: "dir", enc: "A128GCM", kid: "fixture" })
        .encrypt(material.subarray(0, 16)),
      // A key management algorithm other than dir.
      await new CompactEncrypt(plaintext)
        .setProtectedHeader({ alg: "A256KW", enc: "A256GCM", kid: "fixture" })
        .encrypt(material),
      // An altered authentication tag.
      [...parts.slice(0, 4), `${tag.at(0) === "A" ? "B" : "A"}${tag.slice(1)}`].join("."),
      "not-a-ciphertext",
    ];

    for (const value of rejected)
      await expect(encryption.decrypt(context, value)).rejects.toMatchObject(unreadable);
  });
});

describe("configured keyrings", () => {
  it("requires PLATFORM_ENCRYPTION_KEYS without file access", async () => {
    expect(() => configuredSecretEncryption({ PLATFORM_ENCRYPTION_KEY: legacyKey })).toThrow(
      "Set PLATFORM_ENCRYPTION_KEYS",
    );

    const ciphertext = await configuredSecretEncryption({
      PLATFORM_ENCRYPTION_KEYS: keyVersion("current"),
    }).encrypt(context, "value");

    expect(decodeProtectedHeader(ciphertext).kid).toBe("current");
  });
});

describe("keyrings", () => {
  it("accepts canonical base64 and base64url keys separated by commas or line breaks", () => {
    const material = randomBytes(32);

    const keyring = parseKeyring(
      ` first:${material.toString("base64")},second:${randomBytes(32).toString("base64url")}\n`,
      "test",
    );

    expect(keyring.map((version) => version.id)).toEqual(["first", "second"]);
    expect(Buffer.from(keyring[0].material)).toEqual(material);
  });

  it("creates distinct random versions", () => {
    const [first, second] = [generateKeyVersion(), generateKeyVersion()];

    expect(parseKeyring(`${first},${second}`, "test")).toHaveLength(2);
  });

  // Both alphabets appear in this key's base64 spelling.
  const mixed = Buffer.alloc(32, 0xfb).toString("base64").replace("/", "_");

  it.each([
    ["no entry", " \n", /must list at least one key version/],
    ["a passphrase", `current:${"a-long-but-not-random-passphrase".repeat(2)}`, /entry 1 must be/],
    ["a short key", `current:${randomBytes(16).toString("base64")}`, /entry 1 must be/],
    ["a long key", `current:${randomBytes(33).toString("base64")}`, /entry 1 must be/],
    ["mixed alphabets", `current:${mixed}`, /entry 1 must be/],
    ["padded base64url", `current:${randomBytes(32).toString("base64url")}=`, /entry 1 must be/],
    [
      "unused trailing bits",
      `current:${randomBytes(32).toString("base64url").slice(0, -1)}B`,
      /entry 1 must be/,
    ],
    ["a missing ID", `:${randomBytes(32).toString("base64")}`, /entry 1 must be/],
    ["an invalid ID", `current key:${randomBytes(32).toString("base64")}`, /entry 1 must be/],
    ["a repeated ID", `${keyVersion("current")},${keyVersion("current")}`, /more than once/],
  ])("rejects %s", (_name, text, message) => {
    expect(() => parseKeyring(text, "PLATFORM_ENCRYPTION_KEYS")).toThrow(message);
  });

  it("rejects one key under two IDs without repeating key material", () => {
    const material = randomBytes(32).toString("base64");

    expect(() => parseKeyring(`one:${material},two:${material}`, "test")).toThrow(
      "test key version two repeats the key of another version",
    );

    const invalid = material.slice(1);

    const rejection = (() => {
      try {
        parseKeyring(`current:${invalid}`, "test");
      } catch (cause) {
        return cause instanceof Error ? cause.message : "";
      }

      return "";
    })();

    expect(rejection).toMatch(/entry 1 must be/);
    expect(rejection).not.toContain(invalid);
  });
});
