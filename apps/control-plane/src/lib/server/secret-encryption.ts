import { CompactEncrypt, compactDecrypt, importJWK } from "jose";
import { z } from "zod";
import { InvalidOperation } from "./errors.ts";
import {
  configuredLegacyKey,
  decryptLegacySecret,
  isLegacyCiphertext,
} from "./legacy-secret-migration.ts";

/**
 * Names the stored value a ciphertext protects. Each kind carries exactly the
 * fields that every writer and reader of that value knows, so encryption and
 * decryption always receive the same context.
 */
export type SecretContext =
  /** A value in `apps.secrets`. */
  | { kind: "app-secret"; organizationId: string; appId: string; name: string }
  /** `organization_settings.directory_secret`. */
  | { kind: "directory-client-secret"; organizationId: string }
  /** `organization_settings.app_client_secret`. */
  | { kind: "app-login-client-secret"; organizationId: string }
  /** The client secret of a pre-plugin `organization_settings.settings.identity`. */
  | { kind: "legacy-sso-client-secret"; organizationId: string }
  /**
   * `sso_provider.oidc_config` or `sso_provider.saml_config`. Better Auth's
   * field transforms receive only the value, so this context cannot name the
   * provider or its organization.
   */
  | { kind: "sso-provider-config"; field: "oidcConfig" | "samlConfig" };

/** One key version: a symmetric JWK (RFC 7517) whose `kid` names it. */
export type KeyVersion = { id: string; jwk: { kty: "oct"; kid: string; k: string } };

/** The first version encrypts new values; the others only decrypt. */
export type Keyring = readonly [KeyVersion, ...KeyVersion[]];

// No colon, so later key namespaces can extend IDs unambiguously.
const keyId = /^[A-Za-z0-9_-]{1,32}$/;

const keySize = 32;

const keySetFormat = `a JWK Set {"keys":[{"kty":"oct","kid":"ID","k":"KEY"}]}, active key first, where ID uses 1 to 32 letters, digits, - or _ and KEY is ${keySize} random bytes in unpadded base64url`;

/** Whether `k` is canonical unpadded base64url of exactly 32 bytes. */
const isKeyMaterial = (k: string) =>
  /^[A-Za-z0-9_-]{43}$/.test(k) &&
  Buffer.from(k, "base64url").length === keySize &&
  // Re-encoding rejects unused trailing bits, so each key has one spelling.
  Buffer.from(k, "base64url").toString("base64url") === k;

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

/** Formats a new keyring with one random key version. */
export const generateKeyring = () =>
  `${JSON.stringify(
    {
      keys: [
        {
          kty: "oct",
          kid: Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex"),
          k: Buffer.from(crypto.getRandomValues(new Uint8Array(keySize))).toString("base64url"),
        },
      ],
    },
    null,
    2,
  )}\n`;

/** Returns whether `keyring` holds every version of `required` with the same key. */
export const includesKeyVersions = (keyring: Keyring, required: Keyring) =>
  required.every((version) =>
    keyring.some((candidate) => candidate.id === version.id && candidate.jwk.k === version.jwk.k),
  );

// Ciphertexts are JWE compact serializations (RFC 7516): direct encryption
// with the key version's 32 bytes, A256GCM, and the version's ID as `kid`.
const header = { alg: "dir", enc: "A256GCM" } as const;

/**
 * Encrypts the customer secrets that the control plane stores. Callers name
 * what they protect and never handle key material. New values always use the
 * active key version of `keyring`. `legacyKey` only decrypts values that
 * releases before the keyring wrote, until they are re-encrypted.
 */
export const createSecretEncryption = ({
  keyring,
  legacyKey,
}: {
  keyring: Keyring;
  legacyKey?: string | undefined;
}) => {
  const keys = new Map<string, ReturnType<typeof importJWK>>();

  const key = (version: KeyVersion) => {
    const existing = keys.get(version.id);

    if (existing) return existing;
    const imported = importJWK(version.jwk);
    keys.set(version.id, imported);

    return imported;
  };

  const decryptJwe = async (ciphertext: string) => {
    const { plaintext } = await compactDecrypt(
      ciphertext,
      (protectedHeader) => {
        const version = keyring.find((candidate) => candidate.id === protectedHeader.kid);

        if (!version) throw new Error("The ciphertext names an unknown key version");

        return key(version);
      },
      {
        keyManagementAlgorithms: [header.alg],
        contentEncryptionAlgorithms: [header.enc],
      },
    );

    return new TextDecoder().decode(plaintext);
  };

  return {
    // The context is not yet bound to the ciphertext. Callers already pass it,
    // so binding it in a later format changes only this module.
    encrypt: async (_context: SecretContext, value: string) => {
      const [active] = keyring;

      return new CompactEncrypt(new TextEncoder().encode(value))
        .setProtectedHeader({ ...header, kid: active.id })
        .encrypt(await key(active));
    },
    decrypt: async (_context: SecretContext, ciphertext: string) => {
      try {
        return isLegacyCiphertext(ciphertext)
          ? await decryptLegacySecret(legacyKey, ciphertext)
          : await decryptJwe(ciphertext);
      } catch {
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message:
            "Stored credentials could not be decrypted. Restore the installation encryption key.",
        });
      }
    },
  };
};

export type SecretEncryption = ReturnType<typeof createSecretEncryption>;

/**
 * Creates the service from settings that need no file access, as on Cloudflare,
 * where the keyring is the required `PLATFORM_ENCRYPTION_KEYS` secret.
 */
export const configuredSecretEncryption = (configuration: {
  PLATFORM_ENCRYPTION_KEYS?: string | undefined;
  PLATFORM_ENCRYPTION_KEY?: string | undefined;
  BETTER_AUTH_SECRET?: string | undefined;
}) => {
  const keys = configuration.PLATFORM_ENCRYPTION_KEYS?.trim();

  if (!keys) throw new Error(`Set PLATFORM_ENCRYPTION_KEYS to ${keySetFormat}`);

  return createSecretEncryption({
    keyring: parseKeyring(keys, "PLATFORM_ENCRYPTION_KEYS"),
    legacyKey: configuredLegacyKey(configuration),
  });
};
