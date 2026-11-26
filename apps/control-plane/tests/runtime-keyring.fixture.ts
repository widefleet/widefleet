import { base64url } from "jose";

/** A runtime keyring with one key version whose 32 bytes all equal `byte`. */
export const runtimeKeyring = (byte = 0xab) =>
  JSON.stringify({
    keys: [{ kty: "oct", kid: "test", k: base64url.encode(new Uint8Array(32).fill(byte)) }],
  });
