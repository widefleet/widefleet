import { appSecretPreparation } from "@platform/contracts";
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader, importJWK } from "jose";
import type { z } from "zod";
import { parseKeyring, type Keyring, type KeyVersion } from "./keyring.ts";
import { isLegacySealed, openLegacy } from "./legacy-runtime-ciphertext.ts";
import type { ParentEnvironment } from "./types.ts";

type Environment = Pick<ParentEnvironment, "WIDEFLEET_SECRETS_KEYS">;

// Sealed values are JWE compact serializations (RFC 7516): direct encryption
// with a key version's 32 bytes, A256GCM, the version's ID as `kid` and the
// value's context as `ctx`. The protected header is authenticated, and opening
// requires the context the reader expects, so a value cannot be moved to
// another object or purpose.
const header = { alg: "dir", enc: "A256GCM" } as const;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

type ParsedKeyring = {
  keyring: Keyring;
  keys: Map<string, ReturnType<typeof importJWK>>;
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

const key = (parsed: ParsedKeyring, version: KeyVersion) => {
  let imported = parsed.keys.get(version.id);

  if (!imported) {
    imported = importJWK(version.jwk);
    parsed.keys.set(version.id, imported);
  }

  return imported;
};

/** Seals `data` for `context` under the active key version. */
export const seal = async (environment: Environment, context: string, data: Uint8Array) => {
  const parsed = runtimeKeyring(environment);
  const [active] = parsed.keyring;

  return new CompactEncrypt(data)
    .setProtectedHeader({ ...header, kid: active.id, ctx: context })
    .encrypt(await key(parsed, active));
};

/** The key version a sealed value names, or `null` for an earlier format or malformed input. */
export const sealedKeyVersion = (value: string) => {
  try {
    return decodeProtectedHeader(value).kid ?? null;
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

/** Opens a value sealed for `context`. Stored values open under any key version. */
export const open = async (
  environment: Environment,
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
      const version = versions.find((candidate) => candidate.id === protectedHeader.kid);

      if (!version) throw new Error("The sealed value names an unknown key version");

      return key(parsed, version);
    },
    { keyManagementAlgorithms: [header.alg], contentEncryptionAlgorithms: [header.enc] },
  );

  if (protectedHeader["ctx"] !== context)
    throw new Error("The sealed value belongs to another context");

  return plaintext;
};

/** Seals text for `scope`. */
export const encryptText = (environment: Environment, scope: string, text: string) =>
  seal(environment, scope, encoder.encode(text));

/** Opens text sealed for `scope`. */
export const decryptText = async (
  environment: Environment,
  scope: string,
  ciphertext: string,
  options?: OpenOptions,
) => decoder.decode(await open(environment, scope, ciphertext, options));

export const encryptSecrets = (
  environment: Environment,
  scope: string,
  secrets: z.infer<typeof appSecretPreparation>["values"],
) => encryptText(environment, scope, JSON.stringify(secrets));

export const decryptSecrets = async (environment: Environment, scope: string, ciphertext: string) =>
  appSecretPreparation.shape.values.parse(
    JSON.parse(await decryptText(environment, scope, ciphertext)),
  );
