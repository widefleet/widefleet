import { base64url } from "jose";

/** A runtime keyring with one key version whose 32 bytes all equal `byte`. */
export const testKeyring = (byte = 0xab, kid = "test") =>
  JSON.stringify({
    keys: [{ kty: "oct", kid, k: base64url.encode(new Uint8Array(32).fill(byte)) }],
  });
