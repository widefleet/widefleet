import { appSecretPreparation } from "@platform/contracts";
import type { z } from "zod";
import {
  createSealing,
  parseKeyring,
  type Keyring,
  type OpenOptions,
} from "@platform/contracts/keyring";
import type { ParentEnvironment } from "./types.ts";

type Environment = Pick<ParentEnvironment, "WIDEFLEET_SECRETS_KEYS">;

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

type ParsedKeyring = { keyring: Keyring; sealing: ReturnType<typeof createSealing> };

const keyrings = new Map<string, ParsedKeyring>();

/** The runtime keyring, active version first. */
export const runtimeKeyring = (environment: Environment) => {
  const text = environment.WIDEFLEET_SECRETS_KEYS;
  let parsed = keyrings.get(text);

  if (!parsed) {
    const keyring = parseKeyring(text, "WIDEFLEET_SECRETS_KEYS");

    parsed = { keyring, sealing: createSealing(keyring, "runtime") };
    keyrings.set(text, parsed);
  }

  return parsed;
};

/** Seals `data` for `purpose` and `context` under the active key version. */
export const seal = (
  environment: Environment,
  purpose: SealPurpose,
  context: string,
  data: Uint8Array,
) => runtimeKeyring(environment).sealing.seal(purpose, context, data);

/** Whether `value` is sealed for `purpose` under the active key version. */
export const sealedUnderActiveVersion = (
  environment: Environment,
  purpose: SealPurpose,
  value: string,
) => runtimeKeyring(environment).sealing.isCurrent(purpose, value);

/** Opens a value sealed for `purpose` and `context`. Stored values open under any key version. */
export const open = (
  environment: Environment,
  purpose: SealPurpose,
  context: string,
  value: string,
  options?: OpenOptions,
) => runtimeKeyring(environment).sealing.open(purpose, context, value, options);

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
