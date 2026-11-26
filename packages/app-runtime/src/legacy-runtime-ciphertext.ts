import { base64url } from "jose";
import type { Keyring } from "@platform/contracts/keyring";

// Temporary. Values written before the runtime keyring used its active key
// version as a raw key. `widefleet runtime rekey` rewrites stored values in the
// keyring format; remove this module once storage is rewritten.

const encoder = new TextEncoder();

const rawKey = (keyring: Keyring) => base64url.decode(keyring[0].jwk.k);

/** Whether `value` is base64 of an IV and AES-GCM ciphertext, which has no JWE segments. */
export const isLegacySealed = (value: string) => !value.includes(".");

/** Opens a value sealed with the raw key, with `scope` as additional data. */
export const openLegacy = async (keyring: Keyring, scope: string, value: string) => {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(scope) },
      await crypto.subtle.importKey("raw", rawKey(keyring), "AES-GCM", false, ["decrypt"]),
      bytes.slice(12),
    ),
  );
};

/** Recovers the exact bytes of an app key wrapped with AES-KW under HKDF(raw key, app ID). */
export const unwrapLegacyAppKey = async (
  keyring: Keyring,
  appId: string,
  wrapped: Uint8Array<ArrayBuffer>,
) => {
  const wrapping = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encoder.encode(`widefleet app key wrapping v1\n${appId}`),
    },
    await crypto.subtle.importKey("raw", rawKey(keyring), "HKDF", false, ["deriveKey"]),
    { name: "AES-KW", length: 256 },
    false,
    ["unwrapKey"],
  );

  // Extractable only here, to move the same bytes into the keyring format.
  const key = await crypto.subtle.unwrapKey(
    "raw",
    wrapped,
    wrapping,
    "AES-KW",
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );

  const exported = await crypto.subtle.exportKey("raw", key);

  if (!(exported instanceof ArrayBuffer)) throw new Error("The app key could not be recovered");

  return new Uint8Array(exported);
};
