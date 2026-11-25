import { CompactEncrypt, compactDecrypt } from "jose";
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

/** One key version: its ID and 32 random bytes. */
export type KeyVersion = { id: string; material: Uint8Array<ArrayBuffer> };

/** The first version encrypts new values; the others only decrypt. */
export type Keyring = readonly [KeyVersion, ...KeyVersion[]];

const keyId = /^[A-Za-z0-9_-]{1,32}$/;

const keySize = 32;

const keyEntry = `ID:KEY, where KEY is ${keySize} random bytes in base64, for example from \`openssl rand -base64 ${keySize}\``;

/**
 * Decodes exactly 32 bytes from canonical base64 (padded) or canonical
 * base64url (unpadded). Each alphabet is checked on its own, so mixed spellings
 * are rejected, and re-encoding rejects unused trailing bits.
 */
const decodeKeyMaterial = (encoded: string) => {
  const encoding = /^[A-Za-z0-9+/]{43}=$/.test(encoded)
    ? "base64"
    : /^[A-Za-z0-9_-]{43}$/.test(encoded)
      ? "base64url"
      : null;

  if (!encoding) return null;
  const material = new Uint8Array(Buffer.from(encoded, encoding));

  return material.length === keySize && Buffer.from(material).toString(encoding) === encoded
    ? material
    : null;
};

const sameMaterial = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/**
 * Parses `ID:KEY` entries separated by commas or line breaks, active version
 * first. `source` names the setting in errors, which never repeat key material.
 */
export const parseKeyring = (text: string, source: string): Keyring => {
  const versions: KeyVersion[] = [];

  for (const [index, entry] of text
    .split(/[\s,]+/)
    .filter(Boolean)
    .entries()) {
    const separator = entry.indexOf(":");
    const id = entry.slice(0, separator);
    const material = separator > 0 ? decodeKeyMaterial(entry.slice(separator + 1)) : null;

    if (!keyId.test(id) || !material)
      throw new Error(
        `${source} entry ${index + 1} must be ${keyEntry}. IDs use 1 to 32 letters, digits, - or _.`,
      );

    if (versions.some((version) => version.id === id))
      throw new Error(`${source} lists key version ${id} more than once`);

    if (versions.some((version) => sameMaterial(version.material, material)))
      throw new Error(`${source} key version ${id} repeats the key of another version`);
    versions.push({ id, material });
  }

  const [active, ...others] = versions;

  if (!active) throw new Error(`${source} must list at least one key version as ${keyEntry}`);

  return [active, ...others];
};

/** Formats a new random key version for a keyring. */
export const generateKeyVersion = () => {
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");

  return `${id}:${Buffer.from(crypto.getRandomValues(new Uint8Array(keySize))).toString("base64url")}`;
};

/** Returns whether `keyring` holds every version of `required` with the same key. */
export const includesKeyVersions = (keyring: Keyring, required: Keyring) =>
  required.every((version) =>
    keyring.some(
      (candidate) =>
        candidate.id === version.id && sameMaterial(candidate.material, version.material),
    ),
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
  const decryptJwe = async (ciphertext: string) => {
    const { plaintext } = await compactDecrypt(
      ciphertext,
      (protectedHeader) => {
        const version = keyring.find((candidate) => candidate.id === protectedHeader.kid);

        if (!version) throw new Error("The ciphertext names an unknown key version");

        return version.material;
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
        .encrypt(active.material);
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

  if (!keys) throw new Error(`Set PLATFORM_ENCRYPTION_KEYS to ${keyEntry}`);

  return createSecretEncryption({
    keyring: parseKeyring(keys, "PLATFORM_ENCRYPTION_KEYS"),
    legacyKey: configuredLegacyKey(configuration),
  });
};
