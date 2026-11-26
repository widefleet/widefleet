import { base64url } from "jose";
import { describe, expect, it } from "vitest";
import { testKeyring } from "../fixtures/keyring.ts";
import { decryptText, encryptText, sealedKeyVersion } from "./secrets.ts";

const encoder = new TextEncoder();

const keyring = (...versions: [kid: string, byte: number][]) => ({
  WIDEFLEET_SECRETS_KEYS: JSON.stringify({
    keys: versions.map(([kid, byte]) => ({
      kty: "oct",
      kid,
      k: base64url.encode(new Uint8Array(32).fill(byte)),
    })),
  }),
});

describe("runtime sealing", () => {
  it("seals under the active key version and opens only for the same context", async () => {
    const environment = { WIDEFLEET_SECRETS_KEYS: testKeyring() };
    const sealed = await encryptText(environment, "app-secrets/first/1.json", "value");

    expect(sealedKeyVersion(sealed)).toBe("test");
    expect(await decryptText(environment, "app-secrets/first/1.json", sealed)).toBe("value");
    await expect(decryptText(environment, "app-secrets/second/1.json", sealed)).rejects.toThrow(
      "The sealed value belongs to another context",
    );
  });

  it("opens stored values under an earlier key version and bearer values only under the active one", async () => {
    const sealed = await encryptText(keyring(["one", 1]), "scope", "value");
    const rotated = keyring(["two", 2], ["one", 1]);

    expect(await decryptText(rotated, "scope", sealed)).toBe("value");
    await expect(decryptText(rotated, "scope", sealed, { activeOnly: true })).rejects.toThrow(
      "The sealed value names an unknown key version",
    );
    expect(sealedKeyVersion(await encryptText(rotated, "scope", "value"))).toBe("two");
    await expect(decryptText(keyring(["two", 2]), "scope", sealed)).rejects.toThrow(
      "The sealed value names an unknown key version",
    );
  });

  it("opens a value sealed before the runtime keyring with the active key's bytes", async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode("scope") },
        await crypto.subtle.importKey("raw", new Uint8Array(32).fill(0xab), "AES-GCM", false, [
          "encrypt",
        ]),
        encoder.encode("value"),
      ),
    );

    const earlier = btoa(String.fromCharCode(...iv, ...sealed));
    const environment = { WIDEFLEET_SECRETS_KEYS: testKeyring() };

    expect(sealedKeyVersion(earlier)).toBeNull();
    expect(await decryptText(environment, "scope", earlier)).toBe("value");
    await expect(decryptText(environment, "other", earlier)).rejects.toThrow();
  });
});
