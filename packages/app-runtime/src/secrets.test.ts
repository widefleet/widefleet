import { compactDecrypt, decodeProtectedHeader } from "jose";
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

  it("opens a value only for the purpose it was sealed for", async () => {
    const environment = { WIDEFLEET_SECRETS_KEYS: testKeyring() };
    const sealed = await encryptText(environment, "oauth-state", "scope", "value");

    await expect(decryptText(environment, "oauth-access", "scope", sealed)).rejects.toThrow(
      "The sealed value names an unknown key version or purpose",
    );
  });

  it("derives an independent key for each purpose", async () => {
    const environment = { WIDEFLEET_SECRETS_KEYS: testKeyring() };
    const root = new Uint8Array(32).fill(0xab);

    const purposes = [
      "app-secrets",
      "app-keys",
      "workload-keys",
      "oauth-access",
      "oauth-refresh",
      "oauth-state",
    ] as const;

    // The expected key, derived here independently of the runtime's implementation.
    const expectedKey = async (purpose: string) =>
      new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(32),
            info: encoder.encode(`widefleet runtime ${purpose} v1`),
          },
          await crypto.subtle.importKey("raw", root, "HKDF", false, ["deriveBits"]),
          256,
        ),
      );

    for (const purpose of purposes) {
      const sealed = await encryptText(environment, purpose, "scope", "value");
      const { plaintext } = await compactDecrypt(sealed, await expectedKey(purpose));

      expect(new TextDecoder().decode(plaintext)).toBe("value");

      for (const other of purposes.filter((candidate) => candidate !== purpose))
        await expect(compactDecrypt(sealed, await expectedKey(other))).rejects.toThrow();
      await expect(compactDecrypt(sealed, root)).rejects.toThrow();
    }
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
