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

// Ciphertexts are JWE compact serializations (RFC 7516): direct encryption with
// A256GCM, `kid` naming the key version and the kind of value as
// `<version>:<kind>`, and the value's context as `ctx`. Each version derives
// one key per kind with HKDF-SHA256 (RFC 5869). The protected header is
// authenticated, and decryption requires the context the caller names, so a
// value cannot be moved to another row, organization or kind.
const header = { alg: "dir", enc: "A256GCM" } as const;

const encoder = new TextEncoder();

// A fixed salt of hash length, as RFC 5869 recommends when no random salt is kept.
const salt = new Uint8Array(32);

/** The canonical form of a context: its fields in a fixed order. */
const contextLabel = (context: SecretContext) =>
  JSON.stringify(
    context.kind === "app-secret"
      ? [context.kind, context.organizationId, context.appId, context.name]
      : context.kind === "sso-provider-config"
        ? [context.kind, context.field]
        : [context.kind, context.organizationId],
  );

const keyId = (version: KeyVersion, context: SecretContext) => `${version.id}:${context.kind}`;

const protectedKeyId = (ciphertext: string) => {
  try {
    return decodeProtectedHeader(ciphertext).kid ?? null;
  } catch {
    return null;
  }
};

/** The key version a JWE ciphertext names, or `null` when it names none or is malformed. */
export const ciphertextKeyVersion = (ciphertext: string) =>
  protectedKeyId(ciphertext)?.split(":")[0] ?? null;

/**
 * Temporary: whether a ciphertext names only a key version, as values written
 * before keys per kind do. `reencrypt` moves them; remove with their reader.
 */
export const isEarlierCiphertextFormat = (ciphertext: string) => {
  const kid = protectedKeyId(ciphertext);

  return kid !== null && !kid.includes(":");
};

/**
 * Encrypts the customer secrets that the control plane stores. Callers name
 * what they protect and never handle key material. New values always use the
 * active key version of `keyring`.
 */
export const createSecretEncryption = ({ keyring }: { keyring: Keyring }) => {
  const keys = new Map<string, Promise<CryptoKey>>();

  const key = (version: KeyVersion, context: SecretContext) => {
    const id = keyId(version, context);
    let derived = keys.get(id);

    if (!derived) {
      derived = crypto.subtle
        .importKey("raw", Buffer.from(version.jwk.k, "base64url"), "HKDF", false, ["deriveKey"])
        .then((root) =>
          crypto.subtle.deriveKey(
            {
              name: "HKDF",
              hash: "SHA-256",
              salt,
              info: encoder.encode(`widefleet control-plane ${context.kind} v1`),
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

  // Temporary: values written before keys per kind used the version's bytes.
  const earlierKeys = new Map<string, ReturnType<typeof importJWK>>();

  const earlierKey = (version: KeyVersion) => {
    let imported = earlierKeys.get(version.id);

    if (!imported) {
      imported = importJWK(version.jwk);
      earlierKeys.set(version.id, imported);
    }

    return imported;
  };

  const decryptJwe = async (context: SecretContext, ciphertext: string) => {
    let earlier = false;

    const { plaintext, protectedHeader } = await compactDecrypt(
      ciphertext,
      (protectedHeader) => {
        const [id, kind, ...rest] = (protectedHeader.kid ?? "").split(":");
        const version = keyring.find((candidate) => candidate.id === id);

        if (!version || rest.length > 0)
          throw new Error("The ciphertext names an unknown key version");

        if (kind === undefined) {
          earlier = true;

          return earlierKey(version);
        }

        if (kind !== context.kind) throw new Error("The ciphertext belongs to another kind");

        return key(version, context);
      },
      {
        keyManagementAlgorithms: [header.alg],
        contentEncryptionAlgorithms: [header.enc],
      },
    );

    if (!earlier && protectedHeader["ctx"] !== contextLabel(context))
      throw new Error("The ciphertext belongs to another context");

    return new TextDecoder().decode(plaintext);
  };

  return {
    /** The version that encrypts new values. */
    activeKeyVersion: keyring[0].id,
    /** Every version this installation can decrypt, active first. */
    keyVersions: keyring.map((version) => version.id),
    /** Whether `ciphertext` uses the active version's key for the kind of `context`. */
    isCurrent: (context: SecretContext, ciphertext: string) =>
      protectedKeyId(ciphertext) === keyId(keyring[0], context),
    encrypt: async (context: SecretContext, value: string) => {
      const [active] = keyring;

      return new CompactEncrypt(encoder.encode(value))
        .setProtectedHeader({ ...header, kid: keyId(active, context), ctx: contextLabel(context) })
        .encrypt(await key(active, context));
    },
    decrypt: async (context: SecretContext, ciphertext: string) => {
      try {
        return await decryptJwe(context, ciphertext);
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
