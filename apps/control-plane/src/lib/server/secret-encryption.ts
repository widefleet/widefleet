import { CompactEncrypt, compactDecrypt, decodeProtectedHeader, importJWK } from "jose";
import {
  keySetFormat,
  parseKeyring,
  type Keyring,
  type KeyVersion,
} from "@platform/contracts/keyring";
import { InvalidOperation } from "./errors.ts";

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
  /**
   * `sso_provider.oidc_config` or `sso_provider.saml_config`. Better Auth's
   * field transforms receive only the value, so this context cannot name the
   * provider or its organization.
   */
  | { kind: "sso-provider-config"; field: "oidcConfig" | "samlConfig" };

export {
  generateKeyring,
  includesKeyVersions,
  parseKeyring,
  type Keyring,
  type KeyVersion,
} from "@platform/contracts/keyring";

// Ciphertexts are JWE compact serializations (RFC 7516): direct encryption
// with the key version's 32 bytes, A256GCM, and the version's ID as `kid`.
const header = { alg: "dir", enc: "A256GCM" } as const;

/** The key version a JWE ciphertext names, or `null` when it names none or is malformed. */
export const ciphertextKeyVersion = (ciphertext: string) => {
  try {
    return decodeProtectedHeader(ciphertext).kid ?? null;
  } catch {
    return null;
  }
};

/**
 * Encrypts the customer secrets that the control plane stores. Callers name
 * what they protect and never handle key material. New values always use the
 * active key version of `keyring`.
 */
export const createSecretEncryption = ({ keyring }: { keyring: Keyring }) => {
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
    /** The version that encrypts new values. */
    activeKeyVersion: keyring[0].id,
    /** Every version this installation can decrypt, active first. */
    keyVersions: keyring.map((version) => version.id),
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
        return await decryptJwe(ciphertext);
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
}) => {
  const keys = configuration.PLATFORM_ENCRYPTION_KEYS?.trim();

  if (!keys) throw new Error(`Set PLATFORM_ENCRYPTION_KEYS to ${keySetFormat}`);

  return createSecretEncryption({ keyring: parseKeyring(keys, "PLATFORM_ENCRYPTION_KEYS") });
};
