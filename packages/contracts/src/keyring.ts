import { CompactEncrypt, base64url, compactDecrypt, decodeProtectedHeader } from "jose";
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

// Sealed values are JWE compact serializations (RFC 7516): direct encryption
// with A256GCM, `kid` naming the key version and the purpose as
// `<version>:<purpose>`, and the value's context as `ctx`. Each version derives
// one key per purpose with HKDF-SHA256 (RFC 5869), so a weakness in how one
// purpose uses its key does not reach the others. The protected header is
// authenticated, and opening requires the context the reader expects, so a
// value cannot be moved to another object or purpose.
const header = { alg: "dir", enc: "A256GCM" } as const;

const encoder = new TextEncoder();

// A fixed salt of hash length, as RFC 5869 recommends when no random salt is kept.
const salt = new Uint8Array(32);

/** The `kid` a sealed value names, or `null` when it names none or is malformed. */
export const sealedKeyId = (value: string) => {
  try {
    const kid = z.string().safeParse(decodeProtectedHeader(value).kid);

    return kid.success ? kid.data : null;
  } catch {
    return null;
  }
};

export type OpenOptions = {
  /**
   * Accepts only the active key version. Bearer values that clients hold use
   * this, so a new active version retires every bearer value sealed earlier.
   */
  activeOnly?: boolean;
};

/**
 * Seals and opens values with `keyring`. `namespace` separates the derived
 * keys of different services that could share key material.
 */
export const createSealing = (keyring: Keyring, namespace: string) => {
  const keys = new Map<string, Promise<CryptoKey>>();

  const keyId = (version: KeyVersion, purpose: string) => `${version.id}:${purpose}`;

  const key = (version: KeyVersion, purpose: string) => {
    const id = keyId(version, purpose);
    let derived = keys.get(id);

    if (!derived) {
      derived = crypto.subtle
        .importKey("raw", new Uint8Array(base64url.decode(version.jwk.k)), "HKDF", false, [
          "deriveKey",
        ])
        .then((root) =>
          crypto.subtle.deriveKey(
            {
              name: "HKDF",
              hash: "SHA-256",
              salt,
              info: encoder.encode(`widefleet ${namespace} ${purpose} v1`),
            },
            root,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          ),
        );
      keys.set(id, derived);
    }

    return derived;
  };

  return {
    /** Whether `value` is sealed for `purpose` under the active key version. */
    isCurrent: (purpose: string, value: string) =>
      sealedKeyId(value) === keyId(keyring[0], purpose),

    /** Seals `data` for `purpose` and `context` under the active key version. */
    seal: async (purpose: string, context: string, data: Uint8Array) =>
      new CompactEncrypt(data)
        .setProtectedHeader({ ...header, kid: keyId(keyring[0], purpose), ctx: context })
        .encrypt(await key(keyring[0], purpose)),

    /** Opens a value sealed for `purpose` and `context`. */
    open: async (
      purpose: string,
      context: string,
      value: string,
      { activeOnly = false }: OpenOptions = {},
    ) => {
      const versions = activeOnly ? keyring.slice(0, 1) : keyring;

      const { plaintext, protectedHeader } = await compactDecrypt(
        value,
        (protectedHeader) => {
          const version = versions.find(
            (candidate) => keyId(candidate, purpose) === protectedHeader.kid,
          );

          if (!version) throw new Error("The sealed value names an unknown key version or purpose");

          return key(version, purpose);
        },
        { keyManagementAlgorithms: [header.alg], contentEncryptionAlgorithms: [header.enc] },
      );

      if (protectedHeader["ctx"] !== context)
        throw new Error("The sealed value belongs to another context");

      return plaintext;
    },
  };
};
