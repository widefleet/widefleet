import { base64url } from "jose";

/**
 * A runtime keyring, active version first. Each version is a key ID and the
 * byte its 32 key bytes repeat; without versions it is `test` with 0xab.
 */
export const testKeyring = (...versions: [kid: string, byte: number][]) =>
  JSON.stringify({
    keys: (versions.length > 0 ? versions : [["test", 0xab] as const]).map(([kid, byte]) => ({
      kty: "oct",
      kid,
      k: base64url.encode(new Uint8Array(32).fill(byte)),
    })),
  });
