import { createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import {
  createSecretEncryption,
  generateKeyVersion,
  parseKeyring,
} from "../src/lib/server/secret-encryption.ts";

const legacyKey = "synthetic-legacy-installation-key-for-tests";

const context = { kind: "directory-client-secret", organizationId: "widefleet" } as const;

// Synthetic key material: byte values 255 down to 224.
const fixtureKey = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA";

const keyVersion = (id: string) => `${id}:${randomBytes(32).toString("base64")}`;

const unreadable = {
  code: "BAD_REQUEST",
  message: "Stored credentials could not be decrypted. Restore the installation encryption key.",
};

describe("legacy ciphertexts", () => {
  // Recorded from better-auth's symmetricEncrypt with the synthetic key above.
  const stored =
    "04170b74ec840be7258e5c66a39a6a3455ee568a0ea14a8df2866f47bf919593d5bf7849c95bf27ecb86c01f03052ca9329cab0882bbedc2";

  it("decrypts ciphertexts that earlier releases stored, with or without a keyring", async () => {
    const keyring = parseKeyring(keyVersion("current"), "test");

    expect(await createSecretEncryption({ legacyKey }).decrypt(context, stored)).toBe(
      "synthetic secret",
    );
    expect(await createSecretEncryption({ legacyKey, keyring }).decrypt(context, stored)).toBe(
      "synthetic secret",
    );
  });

  it("keeps writing the legacy format without a keyring", async () => {
    const encryption = createSecretEncryption({ legacyKey });
    const ciphertext = await encryption.encrypt(context, "synthetic secret");

    expect(ciphertext).toMatch(/^[a-f0-9]+$/);
    expect(await symmetricDecrypt({ key: legacyKey, data: ciphertext })).toBe("synthetic secret");
    expect(await encryption.decrypt(context, ciphertext)).toBe("synthetic secret");
  });

  it("asks for the installation key when the legacy key differs", async () => {
    const ciphertext = await symmetricEncrypt({ key: legacyKey, data: "value" });

    await expect(
      createSecretEncryption({ legacyKey: "another-synthetic-installation-key" }).decrypt(
        context,
        ciphertext,
      ),
    ).rejects.toMatchObject(unreadable);
  });
});

describe("versioned ciphertexts", () => {
  it("writes AES-256-GCM under an HKDF-SHA256 subkey of the active version", async () => {
    const encryption = createSecretEncryption({
      legacyKey,
      keyring: parseKeyring(`fixture:${fixtureKey}`, "test"),
    });

    const ciphertext = await encryption.encrypt(context, "synthetic secret");
    const [format, id, payload] = ciphertext.split(":");

    expect([format, id]).toEqual(["v1", "fixture"]);
    expect(await encryption.encrypt(context, "synthetic secret")).not.toBe(ciphertext);

    // Decrypt independently of the service to pin the format.
    const bytes = Buffer.from(payload ?? "", "base64url");

    const subkey = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(fixtureKey, "base64url"),
        Buffer.alloc(0),
        "widefleet control plane stored secrets",
        32,
      ),
    );

    const decipher = createDecipheriv("aes-256-gcm", subkey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    expect(
      Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(),
    ).toBe("synthetic secret");
  });

  it("decrypts versioned ciphertexts that earlier releases stored", async () => {
    // Recorded from this format with the synthetic fixture key.
    const stored = "v1:fixture:YDmk8RnFCeVMWv3lKdvpMgGdbPJSciBe197rugwhn2umd_wDVZ6a2iKZQyY";

    const encryption = createSecretEncryption({
      legacyKey,
      keyring: parseKeyring(`fixture:${fixtureKey}`, "test"),
    });

    expect(await encryption.decrypt(context, stored)).toBe("synthetic secret");
  });

  it("encrypts with a new active version while earlier versions still decrypt", async () => {
    const previous = keyVersion("previous");
    const before = createSecretEncryption({ legacyKey, keyring: parseKeyring(previous, "test") });
    const old = await before.encrypt(context, "written before rotation");

    const after = createSecretEncryption({
      legacyKey,
      keyring: parseKeyring(`${keyVersion("current")}\n${previous}`, "test"),
    });

    const current = await after.encrypt(context, "written after rotation");

    expect(current).toMatch(/^v1:current:/);
    expect(await after.decrypt(context, old)).toBe("written before rotation");
    expect(await after.decrypt(context, current)).toBe("written after rotation");
    await expect(before.decrypt(context, current)).rejects.toMatchObject(unreadable);
  });

  it("rejects altered ciphertexts and unknown formats", async () => {
    const encryption = createSecretEncryption({
      legacyKey,
      keyring: parseKeyring(keyVersion("current"), "test"),
    });

    const ciphertext = await encryption.encrypt(context, "value");
    const last = ciphertext.at(-1) === "A" ? "B" : "A";

    for (const altered of [
      `${ciphertext.slice(0, -1)}${last}`,
      ciphertext.replace("v1:", "v2:"),
      `${ciphertext}:extra`,
      "v1:current:",
    ])
      await expect(encryption.decrypt(context, altered)).rejects.toMatchObject(unreadable);
  });
});

describe("keyrings", () => {
  it("accepts base64 and base64url keys separated by commas or line breaks, active first", () => {
    const material = randomBytes(32);

    const keyring = parseKeyring(
      ` first:${material.toString("base64")},second:${randomBytes(32).toString("base64url")}\nthird:${randomBytes(32).toString("base64url")}=\n`,
      "test",
    );

    expect(keyring.map((version) => version.id)).toEqual(["first", "second", "third"]);
    expect(Buffer.from(keyring[0].material)).toEqual(material);
  });

  it("creates distinct random versions", () => {
    const [first, second] = [generateKeyVersion(), generateKeyVersion()];

    expect(parseKeyring(`${first},${second}`, "test")).toHaveLength(2);
  });

  it.each([
    ["no entry", " \n", /must list at least one key version/],
    ["a passphrase", `current:${"a-long-but-not-random-passphrase".repeat(2)}`, /entry 1 must be/],
    ["a short key", `current:${randomBytes(16).toString("base64")}`, /entry 1 must be/],
    ["a long key", `current:${randomBytes(33).toString("base64")}`, /entry 1 must be/],
    [
      "unused trailing bits",
      `current:${randomBytes(32).toString("base64url").slice(0, -1)}B`,
      /entry 1 must be/,
    ],
    ["a missing ID", `:${randomBytes(32).toString("base64")}`, /entry 1 must be/],
    ["an invalid ID", `current key:${randomBytes(32).toString("base64")}`, /entry 1 must be/],
    ["repeated bytes", `current:${Buffer.alloc(32, 7).toString("base64")}`, /is not random/],
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
