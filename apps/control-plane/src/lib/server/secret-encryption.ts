import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
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

/** Decodes canonical base64 or base64url of exactly 32 bytes, padded or not. */
const decodeKeyMaterial = (encoded: string) => {
  const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/").replace(/=$/, "");

  if (!/^[A-Za-z0-9+/]{43}$/.test(normalized)) return null;
  const material = new Uint8Array(Buffer.from(normalized, "base64"));

  // Re-encoding rejects unused trailing bits, so each key has one spelling.
  return Buffer.from(material).toString("base64").replace(/=$/, "") === normalized
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

    // Random bytes repeat few values; a placeholder or typed pattern repeats many.
    if (new Set(material).size < 16)
      throw new Error(`${source} key version ${id} is not random. Generate it as ${keyEntry}.`);

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

// Versioned ciphertexts are `v1:<key ID>:<base64url of IV and sealed value>`.
// Legacy ciphertexts are bare hexadecimal and never contain a colon.
const format = "v1";

const ivSize = 12;

// Ties the derived AES key to this use of the key version.
const subkeyInfo = new TextEncoder().encode("widefleet control plane stored secrets");

const deriveSubkey = async (material: Uint8Array<ArrayBuffer>) =>
  crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: subkeyInfo },
    await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

/**
 * Encrypts the customer secrets that the control plane stores. Callers name
 * what they protect and never handle key material. New values use the active
 * key version of `keyring`; without a keyring they keep the legacy format.
 * Unprefixed legacy ciphertexts always decrypt with `legacyKey`.
 */
export const createSecretEncryption = ({
  legacyKey,
  keyring,
}: {
  legacyKey: string;
  keyring?: Keyring | undefined;
}) => {
  const subkeys = new Map<string, Promise<CryptoKey>>();

  const subkey = (version: KeyVersion) => {
    const existing = subkeys.get(version.id);

    if (existing) return existing;
    const derived = deriveSubkey(version.material);
    subkeys.set(version.id, derived);

    return derived;
  };

  const decryptVersioned = async (ciphertext: string) => {
    const [prefix, id, payload, ...rest] = ciphertext.split(":");
    const version = keyring?.find((candidate) => candidate.id === id);

    if (prefix !== format || !version || payload === undefined || rest.length > 0)
      throw new Error("Unsupported ciphertext");
    const bytes = new Uint8Array(Buffer.from(payload, "base64url"));

    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, ivSize) },
        await subkey(version),
        bytes.slice(ivSize),
      ),
    );
  };

  return {
    // The context is not yet bound to the ciphertext. Callers already pass it,
    // so binding it in a later format changes only this module.
    encrypt: async (_context: SecretContext, value: string) => {
      const active = keyring?.[0];

      if (!active) return symmetricEncrypt({ key: legacyKey, data: value });
      const iv = crypto.getRandomValues(new Uint8Array(ivSize));

      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await subkey(active),
        new TextEncoder().encode(value),
      );

      const payload = Buffer.concat([iv, new Uint8Array(sealed)]).toString("base64url");

      return `${format}:${active.id}:${payload}`;
    },
    decrypt: async (_context: SecretContext, ciphertext: string) => {
      try {
        return ciphertext.includes(":")
          ? await decryptVersioned(ciphertext)
          : await symmetricDecrypt({ key: legacyKey, data: ciphertext });
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
 * where the keyring is the `PLATFORM_ENCRYPTION_KEYS` secret.
 */
export const configuredSecretEncryption = (legacyKey: string, keys: string | undefined) =>
  createSecretEncryption({
    legacyKey,
    keyring: keys?.trim() ? parseKeyring(keys, "PLATFORM_ENCRYPTION_KEYS") : undefined,
  });
