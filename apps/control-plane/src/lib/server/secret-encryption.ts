import { compactDecrypt, importJWK } from "jose";
import {
  createSealing,
  keySetFormat,
  parseKeyring,
  sealedKeyId,
  type Keyring,
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

/** Formats a new keyring with one random key version. */
export const generateKeyring = () =>
  `${JSON.stringify(
    {
      keys: [
        {
          kty: "oct",
          kid: Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex"),
          k: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
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

// Ciphertexts are sealed with the shared keyring format: one key per kind of
// value, and the value's context as `ctx`, so a value cannot be moved to
// another kind, or to another row or organization its context names.

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/** The canonical form of a context: its fields in a fixed order. */
const contextLabel = (context: SecretContext) =>
  JSON.stringify(
    context.kind === "app-secret"
      ? [context.kind, context.organizationId, context.appId, context.name]
      : context.kind === "sso-provider-config"
        ? [context.kind, context.field]
        : [context.kind, context.organizationId],
  );

/** The key version a ciphertext names, or `null` when it names none or is malformed. */
export const ciphertextKeyVersion = (ciphertext: string) =>
  sealedKeyId(ciphertext)?.split(":")[0] ?? null;

/**
 * Temporary: whether a ciphertext names only a key version, as values written
 * before keys per kind do. `reencrypt` moves them; remove with their reader.
 */
export const isEarlierCiphertextFormat = (ciphertext: string) => {
  const kid = sealedKeyId(ciphertext);

  return kid !== null && !kid.includes(":");
};

/**
 * Encrypts the customer secrets that the control plane stores. Callers name
 * what they protect and never handle key material. New values always use the
 * active key version of `keyring`.
 */
export const createSecretEncryption = ({ keyring }: { keyring: Keyring }) => {
  const sealing = createSealing(keyring, "control-plane");

  // Temporary: values written before keys per kind use the version's own bytes.
  const openEarlier = async (ciphertext: string) =>
    (
      await compactDecrypt(
        ciphertext,
        (protectedHeader) => {
          const version = keyring.find((candidate) => candidate.id === protectedHeader.kid);

          if (!version) throw new Error("The ciphertext names an unknown key version");

          return importJWK(version.jwk);
        },
        { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] },
      )
    ).plaintext;

  return {
    /** The version that encrypts new values. */
    activeKeyVersion: keyring[0].id,
    /** Every version this installation can decrypt, active first. */
    keyVersions: keyring.map((version) => version.id),
    /** Whether `ciphertext` uses the active version's key for the kind of `context`. */
    isCurrent: (context: SecretContext, ciphertext: string) =>
      sealing.isCurrent(context.kind, ciphertext),
    encrypt: (context: SecretContext, value: string) =>
      sealing.seal(context.kind, contextLabel(context), encoder.encode(value)),
    decrypt: async (context: SecretContext, ciphertext: string) => {
      try {
        return decoder.decode(
          isEarlierCiphertextFormat(ciphertext)
            ? await openEarlier(ciphertext)
            : await sealing.open(context.kind, contextLabel(context), ciphertext),
        );
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
