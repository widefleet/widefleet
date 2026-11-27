import { base64url } from "jose";

// Temporary, removed with legacy-runtime-ciphertext.ts: values as runtimes
// before the keyring stored them, under a raw key whose 32 bytes repeat `byte`.

const encoder = new TextEncoder();

const rawKey = (byte: number) => new Uint8Array(32).fill(byte);

/** base64(iv || AES-GCM) with `scope` as additional data. */
export const sealedBeforeKeyring = async (byte: number, scope: string, text: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(scope) },
      await crypto.subtle.importKey("raw", rawKey(byte), "AES-GCM", false, ["encrypt"]),
      encoder.encode(text),
    ),
  );

  return btoa(String.fromCharCode(...iv, ...sealed));
};

/** An app key record: AES-KW under HKDF(raw key, app ID). */
export const appKeyBeforeKeyring = async (
  byte: number,
  appId: string,
  material: Uint8Array<ArrayBuffer>,
) => {
  const wrapping = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encoder.encode(`widefleet app key wrapping v1\n${appId}`),
    },
    await crypto.subtle.importKey("raw", rawKey(byte), "HKDF", false, ["deriveKey"]),
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
