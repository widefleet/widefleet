import { createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { CompactEncrypt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { parseKeyring } from "@platform/contracts/keyring";
import {
  ciphertextKeyVersion,
  configuredSecretEncryption,
  createSecretEncryption,
  generateKeyring,
} from "../src/lib/server/secret-encryption.ts";
import { keySet, keyVersion } from "./keyring.fixture.ts";

const context = { kind: "directory-client-secret", organizationId: "widefleet" } as const;

// Synthetic key material: byte values 255 down to 224.
const fixtureKey = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA";

const fixture = () => parseKeyring(keySet(keyVersion("fixture", fixtureKey)), "test");

const keyring = (...keys: ReturnType<typeof keyVersion>[]) => parseKeyring(keySet(...keys), "test");

const unreadable = {
  code: "BAD_REQUEST",
  message: "Stored credentials could not be decrypted. Restore the installation encryption key.",
};

/** The key of one kind of value, derived with node:crypto alone, outside our code path. */
const derivedKey = (key: Buffer, kind: string) =>
  Buffer.from(hkdfSync("sha256", key, Buffer.alloc(32), `widefleet control-plane ${kind} v1`, 32));

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

describe("JWE ciphertexts", () => {
  it("writes compact JWE with the active version's key for the kind and the context", async () => {
    const encryption = createSecretEncryption({ keyring: fixture() });
    const ciphertext = await encryption.encrypt(context, "synthetic secret");
    const key = Buffer.from(fixtureKey, "base64url");

    expect(decodeProtectedHeader(ciphertext)).toEqual({
      alg: "dir",
      enc: "A256GCM",
      kid: "fixture:directory-client-secret",
      ctx: '["directory-client-secret","widefleet"]',
    });
    expect(await encryption.encrypt(context, "synthetic secret")).not.toBe(ciphertext);
    expect(decryptIndependently(ciphertext, derivedKey(key, "directory-client-secret"))).toBe(
      "synthetic secret",
    );
    expect(() => decryptIndependently(ciphertext, key)).toThrow();
    expect(() =>
      decryptIndependently(ciphertext, derivedKey(key, "app-login-client-secret")),
    ).toThrow();
  });

  it("decrypts a recorded JWE, which node:crypto also decrypts on its own", async () => {
    // Recorded with the synthetic fixture key; pins the stored format.
    const stored =
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwia2lkIjoiZml4dHVyZTpkaXJlY3RvcnktY2xpZW50LXNlY3JldCIsImN0eCI6IltcImRpcmVjdG9yeS1jbGllbnQtc2VjcmV0XCIsXCJ3aWRlZmxlZXRcIl0ifQ..8IFEEjSoYq4y8tL_.KgU7UcUzt8I4yp1XBw1YLA.iZ1cRxZe-2uhEdL75GapjA";

    expect(
      decryptIndependently(
        stored,
        derivedKey(Buffer.from(fixtureKey, "base64url"), "directory-client-secret"),
      ),
    ).toBe("synthetic secret");
    expect(await createSecretEncryption({ keyring: fixture() }).decrypt(context, stored)).toBe(
      "synthetic secret",
    );
  });

  it("decrypts only for the kind and context a value was written for", async () => {
    const encryption = createSecretEncryption({ keyring: fixture() });

    const secret = {
      kind: "app-secret",
      organizationId: "widefleet",
      appId: "2a600000-0000-4000-8000-000000000001",
      name: "TOKEN",
    } as const;

    const ciphertext = await encryption.encrypt(secret, "value");

    expect(await encryption.decrypt(secret, ciphertext)).toBe("value");

    for (const other of [
      { ...secret, name: "OTHER" },
      { ...secret, appId: "2a600000-0000-4000-8000-000000000002" },
      { ...secret, organizationId: "other" },
      { kind: "directory-client-secret", organizationId: "widefleet" },
    ] as const)
      await expect(encryption.decrypt(other, ciphertext)).rejects.toMatchObject(unreadable);
  });

  it("encrypts with a new active version while earlier versions still decrypt", async () => {
    const previous = keyVersion("previous");
    const before = createSecretEncryption({ keyring: keyring(previous) });
    const old = await before.encrypt(context, "written before rotation");

    const after = createSecretEncryption({
      keyring: keyring(keyVersion("current"), previous),
    });

    const current = await after.encrypt(context, "written after rotation");

    expect(ciphertextKeyVersion(current)).toBe("current");
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
    expect(() => configuredSecretEncryption({})).toThrow("Set PLATFORM_ENCRYPTION_KEYS");

    const ciphertext = await configuredSecretEncryption({
      PLATFORM_ENCRYPTION_KEYS: keySet(keyVersion("current")),
    }).encrypt(context, "value");

    expect(ciphertextKeyVersion(ciphertext)).toBe("current");
  });
});

describe("keyrings", () => {
  it("reads a private JWK Set, active key first, and ignores other JWK members", () => {
    const material = randomBytes(32);

    const versions = parseKeyring(
      JSON.stringify({
        keys: [
          { ...keyVersion("first", material.toString("base64url")), alg: "dir", use: "enc" },
          keyVersion("second"),
        ],
      }),
      "test",
    );

    expect(versions.map((version) => version.id)).toEqual(["first", "second"]);
    expect(Buffer.from(versions[0].jwk.k, "base64url")).toEqual(material);
  });

  it("generates a JWK Set with one random key", () => {
    const [first, second] = [
      parseKeyring(generateKeyring(), "test"),
      parseKeyring(generateKeyring(), "test"),
    ];

    expect(first).toHaveLength(1);
    expect(first[0].jwk.k).not.toBe(second[0].jwk.k);
  });

  // Fixed spellings of 32 bytes, so each case fails for its stated reason.
  const urlSafe = "-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_8";
  const standard = Buffer.from(urlSafe, "base64url").toString("base64");

  it.each([
    ["text that is not JSON", "current:key", /must be a JWK Set/],
    ["a document without keys", JSON.stringify({ key: [] }), /must be a JWK Set/],
    ["an empty key set", keySet(), /at least one key/],
    [
      "another key type",
      JSON.stringify({ keys: [{ ...keyVersion("rsa"), kty: "RSA" }] }),
      /key 1 must follow/,
    ],
    ["a kid with a colon", keySet(keyVersion("org:current")), /key 1 must follow/],
    ["a kid longer than 32 characters", keySet(keyVersion("k".repeat(33))), /key 1 must follow/],
    ["padded base64url", keySet(keyVersion("current", `${urlSafe}=`)), /key 1 must follow/],
    ["standard base64", keySet(keyVersion("current", standard)), /key 1 must follow/],
    [
      "a short key",
      keySet(keyVersion("current", randomBytes(16).toString("base64url"))),
      /key 1 must follow/,
    ],
    [
      "a long key",
      keySet(keyVersion("current", randomBytes(33).toString("base64url"))),
      /key 1 must follow/,
    ],
    [
      "unused trailing bits",
      keySet(keyVersion("current", `${urlSafe.slice(0, -1)}9`)),
      /key 1 must follow/,
    ],
    ["a repeated kid", keySet(keyVersion("current"), keyVersion("current")), /more than once/],
  ])("rejects %s", (_name, text, message) => {
    expect(() => parseKeyring(text, "PLATFORM_ENCRYPTION_KEYS")).toThrow(message);
  });

  it("rejects one key under two kids without repeating key material", () => {
    expect(() =>
      parseKeyring(keySet(keyVersion("one", urlSafe), keyVersion("two", urlSafe)), "test"),
    ).toThrow("test key version two repeats the key of another version");

    const invalid = urlSafe.slice(1);

    const rejection = (() => {
      try {
        parseKeyring(keySet(keyVersion("current", invalid)), "test");
      } catch (cause) {
        return cause instanceof Error ? cause.message : "";
      }

      return "";
    })();

    expect(rejection).toMatch(/key 1 must follow/);
    expect(rejection).not.toContain(invalid);
  });
});
