import { CompactEncrypt, base64url, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { testKeyring } from "../fixtures/keyring.ts";
import { sealedBeforeKeyring } from "../fixtures/legacy.ts";
import { decryptText, encryptText, sealedUnderActiveVersion } from "./secrets.ts";

const encoder = new TextEncoder();

const keyring = (...versions: [kid: string, byte: number][]) => ({
  WIDEFLEET_SECRETS_KEYS: testKeyring(...versions),
});

describe("runtime sealing", () => {
  it("seals under the active key version and opens only for the same context", async () => {
    const environment = { WIDEFLEET_SECRETS_KEYS: testKeyring() };

    const sealed = await encryptText(
      environment,
      "app-secrets",
      "app-secrets/first/1.json",
      "value",
    );

    expect(decodeProtectedHeader(sealed)).toMatchObject({
      kid: "test:app-secrets",
      ctx: "app-secrets/first/1.json",
    });
    expect(sealedUnderActiveVersion(environment, "app-secrets", sealed)).toBe(true);
    expect(await decryptText(environment, "app-secrets", "app-secrets/first/1.json", sealed)).toBe(
      "value",
    );
    await expect(
      decryptText(environment, "app-secrets", "app-secrets/second/1.json", sealed),
    ).rejects.toThrow("The sealed value belongs to another context");
  });

  it("derives a separate key for each purpose", async () => {
    const environment = { WIDEFLEET_SECRETS_KEYS: testKeyring() };
    const sealed = await encryptText(environment, "oauth-state", "scope", "value");

    await expect(decryptText(environment, "oauth-access", "scope", sealed)).rejects.toThrow(
      "The sealed value names an unknown key version or purpose",
    );

    // Renaming the purpose in the header still fails, because the key differs.
    const [, , iv, ciphertext, tag] = sealed.split(".");

    const renamed = [
      base64url.encode(
        JSON.stringify({ alg: "dir", enc: "A256GCM", kid: "test:oauth-access", ctx: "scope" }),
      ),
      "",
      iv,
      ciphertext,
      tag,
    ].join(".");

    await expect(decryptText(environment, "oauth-access", "scope", renamed)).rejects.toThrow();

    // The root key itself opens nothing.
    const root = await new CompactEncrypt(encoder.encode("value"))
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: "test", ctx: "scope" })
      .encrypt(new Uint8Array(32).fill(0xab));

    await expect(decryptText(environment, "oauth-state", "scope", root)).rejects.toThrow(
      "The sealed value names an unknown key version or purpose",
    );
  });

  it("opens stored values under an earlier key version and bearer values only under the active one", async () => {
    const sealed = await encryptText(keyring(["one", 1]), "app-secrets", "scope", "value");
    const rotated = keyring(["two", 2], ["one", 1]);

    expect(await decryptText(rotated, "app-secrets", "scope", sealed)).toBe("value");
    expect(sealedUnderActiveVersion(rotated, "app-secrets", sealed)).toBe(false);
    await expect(
      decryptText(rotated, "app-secrets", "scope", sealed, { activeOnly: true }),
    ).rejects.toThrow("The sealed value names an unknown key version or purpose");
    expect(
      decodeProtectedHeader(await encryptText(rotated, "app-secrets", "scope", "value")).kid,
    ).toBe("two:app-secrets");
    await expect(decryptText(keyring(["two", 2]), "app-secrets", "scope", sealed)).rejects.toThrow(
      "The sealed value names an unknown key version or purpose",
    );
  });

  it("opens a value sealed before the runtime keyring with the active key's bytes", async () => {
    const earlier = await sealedBeforeKeyring(0xab, "scope", "value");
    const environment = { WIDEFLEET_SECRETS_KEYS: testKeyring() };

    expect(sealedUnderActiveVersion(environment, "app-secrets", earlier)).toBe(false);
    expect(await decryptText(environment, "app-secrets", "scope", earlier)).toBe("value");
    await expect(decryptText(environment, "app-secrets", "other", earlier)).rejects.toThrow();
  });
});
