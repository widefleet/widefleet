import { base64url } from "jose";
import { z } from "zod";

// The control plane and the runtime keep their keys in the same format: a
// private JWK Set (RFC 7517) of 32-byte symmetric keys, active version first.

/** One key version: a symmetric JWK (RFC 7517) whose `kid` names it. */
export type KeyVersion = { id: string; jwk: { kty: "oct"; kid: string; k: string } };

/** The first version encrypts new values; the others only decrypt. */
export type Keyring = readonly [KeyVersion, ...KeyVersion[]];

// No colon, so later key namespaces can extend IDs unambiguously.
const keyId = /^[A-Za-z0-9_-]{1,32}$/;

const keySize = 32;

export const keySetFormat = `a JWK Set {"keys":[{"kty":"oct","kid":"ID","k":"KEY"}]}, active key first, where ID uses 1 to 32 letters, digits, - or _ and KEY is ${keySize} random bytes in unpadded base64url`;

/** Whether `k` is canonical unpadded base64url of exactly 32 bytes. */
const isKeyMaterial = (k: string) =>
  /^[A-Za-z0-9_-]{43}$/.test(k) &&
  // Re-encoding rejects unused trailing bits, so each key has one spelling.
  base64url.encode(base64url.decode(k)) === k;

const keySet = z.object({ keys: z.array(z.unknown()) });

const symmetricKey = z.looseObject({
  kty: z.literal("oct"),
  kid: z.string().regex(keyId),
  k: z.string().refine(isKeyMaterial),
});

/**
 * Parses a private JWK Set, active version first. `source` names the setting
 * in errors, which never repeat key material.
 */
export const parseKeyring = (text: string, source: string): Keyring => {
  let document: unknown;

  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`${source} must be ${keySetFormat}`);
  }

  const set = keySet.safeParse(document);

  if (!set.success) throw new Error(`${source} must be ${keySetFormat}`);
  const versions: KeyVersion[] = [];

  for (const [index, entry] of set.data.keys.entries()) {
    const parsed = symmetricKey.safeParse(entry);

    if (!parsed.success) throw new Error(`${source} key ${index + 1} must follow ${keySetFormat}`);
    const { kid, k } = parsed.data;

    if (versions.some((version) => version.id === kid))
      throw new Error(`${source} lists key version ${kid} more than once`);

    if (versions.some((version) => version.jwk.k === k))
      throw new Error(`${source} key version ${kid} repeats the key of another version`);
    versions.push({ id: kid, jwk: { kty: "oct", kid, k } });
  }

  const [active, ...others] = versions;

  if (!active) throw new Error(`${source} must list at least one key in ${keySetFormat}`);

  return [active, ...others];
};
