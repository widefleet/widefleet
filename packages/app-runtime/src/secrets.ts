import { appSecretPreparation } from "@platform/contracts";
import { CompactEncrypt, base64url, compactDecrypt, decodeProtectedHeader } from "jose";
import type { z } from "zod";
import { parseKeyring, type Keyring, type KeyVersion } from "@platform/contracts/keyring";
import { isLegacySealed, openLegacy } from "./legacy-runtime-ciphertext.ts";
import type { ParentEnvironment } from "./types.ts";

type Environment = Pick<ParentEnvironment, "WIDEFLEET_SECRETS_KEYS">;

// Sealed values are JWE compact serializations (RFC 7516): direct encryption
// with A256GCM and the value's context as `ctx`. The protected header is
// authenticated, and opening requires the context the reader expects, so a
// value cannot be moved to another object.
//
// Each key version derives one key per purpose with HKDF-SHA256 (RFC 5869), and
// `kid` names both as `<version>:<purpose>`. A weakness in how one purpose uses
// its key then does not reach the others.
const header = { alg: "dir", enc: "A256GCM" } as const;

/** What a runtime key protects. */
export type SealPurpose =
  /** App secret snapshots. */
  | "app-secrets"
  /** The keys behind the `WIDEFLEET_KEYS` binding. */
  | "app-keys"
  /** The workload signing ring. */
  | "workload-keys"
  /** Managed OAuth access token placeholders. */
  | "oauth-access"
  /** Managed OAuth refresh grants. */
  | "oauth-refresh"
  /** Managed OAuth authorization state. */
  | "oauth-state";

const encoder = new TextEncoder();

const decoder = new TextDecoder();

// A fixed salt of hash length, as RFC 5869 recommends when no random salt is kept.
const salt = new Uint8Array(32);

type ParsedKeyring = {
  keyring: Keyring;
  keys: Map<string, Promise<CryptoKey>>;
};

const keyrings = new Map<string, ParsedKeyring>();

/** The runtime keyring, active version first. */
export const runtimeKeyring = (environment: Environment) => {
  const text = environment.WIDEFLEET_SECRETS_KEYS;
  let parsed = keyrings.get(text);

  if (!parsed) {
    parsed = { keyring: parseKeyring(text, "WIDEFLEET_SECRETS_KEYS"), keys: new Map() };
    keyrings.set(text, parsed);
  }

  return parsed;
};

const keyId = (version: KeyVersion, purpose: SealPurpose) => `${version.id}:${purpose}`;

const key = (parsed: ParsedKeyring, version: KeyVersion, purpose: SealPurpose) => {
  const id = keyId(version, purpose);
  let derived = parsed.keys.get(id);

  if (!derived) {
    derived = crypto.subtle
      .importKey("raw", base64url.decode(version.jwk.k), "HKDF", false, ["deriveKey"])
      .then((root) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt,
            info: encoder.encode(`widefleet runtime ${purpose} v1`),
          },
          root,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    parsed.keys.set(id, derived);
  }

  return derived;
};

/** Seals `data` for `purpose` and `context` under the active key version. */
export const seal = async (
  environment: Environment,
  purpose: SealPurpose,
  context: string,
  data: Uint8Array,
) => {
  const parsed = runtimeKeyring(environment);
  const [active] = parsed.keyring;

  return new CompactEncrypt(data)
    .setProtectedHeader({ ...header, kid: keyId(active, purpose), ctx: context })
    .encrypt(await key(parsed, active, purpose));
};

/** Whether `value` is sealed for `purpose` under the active key version. */
export const sealedUnderActiveVersion = (
  environment: Environment,
  purpose: SealPurpose,
  value: string,
) => {
  try {
    return (
      decodeProtectedHeader(value).kid === keyId(runtimeKeyring(environment).keyring[0], purpose)
    );
  } catch {
    return false;
  }
};

export type OpenOptions = {
  /**
   * Accepts only the active key version. Bearer values that clients hold use
   * this, so a new active version retires every bearer value sealed earlier.
   */
  activeOnly?: boolean;
};

/** Opens a value sealed for `purpose` and `context`. Stored values open under any key version. */
export const open = async (
  environment: Environment,
  purpose: SealPurpose,
  context: string,
  value: string,
  { activeOnly = false }: OpenOptions = {},
) => {
  const parsed = runtimeKeyring(environment);

  if (isLegacySealed(value)) return openLegacy(parsed.keyring, context, value);

  const versions = activeOnly ? parsed.keyring.slice(0, 1) : parsed.keyring;

  const { plaintext, protectedHeader } = await compactDecrypt(
    value,
    (protectedHeader) => {
      const version = versions.find(
        (candidate) => keyId(candidate, purpose) === protectedHeader.kid,
      );

      if (!version) throw new Error("The sealed value names an unknown key version or purpose");

      return key(parsed, version, purpose);
    },
    { keyManagementAlgorithms: [header.alg], contentEncryptionAlgorithms: [header.enc] },
  );

  if (protectedHeader["ctx"] !== context)
    throw new Error("The sealed value belongs to another context");

  return plaintext;
};

/** Seals text for `purpose` and `scope`. */
export const encryptText = (
  environment: Environment,
  purpose: SealPurpose,
  scope: string,
  text: string,
) => seal(environment, purpose, scope, encoder.encode(text));

/** Opens text sealed for `purpose` and `scope`. */
export const decryptText = async (
  environment: Environment,
  purpose: SealPurpose,
  scope: string,
  ciphertext: string,
  options?: OpenOptions,
) => decoder.decode(await open(environment, purpose, scope, ciphertext, options));

export const encryptSecrets = (
  environment: Environment,
  purpose: SealPurpose,
  scope: string,
  secrets: z.infer<typeof appSecretPreparation>["values"],
) => encryptText(environment, purpose, scope, JSON.stringify(secrets));

export const decryptSecrets = async (
  environment: Environment,
  purpose: SealPurpose,
  scope: string,
  ciphertext: string,
) =>
  appSecretPreparation.shape.values.parse(
    JSON.parse(await decryptText(environment, purpose, scope, ciphertext)),
  );
