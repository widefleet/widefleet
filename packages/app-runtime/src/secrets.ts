import { appSecretPreparation } from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";

type Environment = Pick<ParentEnvironment, "WIDEFLEET_SECRETS_KEY">;

const key = (environment: Environment) =>
  crypto.subtle.importKey(
    "raw",
    Uint8Array.from(
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(environment.WIDEFLEET_SECRETS_KEY)
        .match(/../g) ?? [],
      (byte) => Number.parseInt(byte, 16),
    ),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

/** Encrypts text with the runtime key, bound to `scope` as additional data. */
export const encryptText = async (environment: Environment, scope: string, text: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(scope) },
      await key(environment),
      new TextEncoder().encode(text),
    ),
  );

  return btoa(
    Array.from(iv, (byte) => String.fromCharCode(byte)).join("") +
      Array.from(encrypted, (byte) => String.fromCharCode(byte)).join(""),
  );
};

export const decryptText = async (environment: Environment, scope: string, ciphertext: string) => {
  const bytes = Uint8Array.from(atob(ciphertext), (character) => character.charCodeAt(0));

  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(scope) },
    await key(environment),
    bytes.slice(12),
  );

  return new TextDecoder().decode(data);
};

export const encryptSecrets = (
  environment: Environment,
  scope: string,
  secrets: z.infer<typeof appSecretPreparation>["values"],
) => encryptText(environment, scope, JSON.stringify(secrets));

export const decryptSecrets = async (environment: Environment, scope: string, ciphertext: string) =>
  appSecretPreparation.shape.values.parse(
    JSON.parse(await decryptText(environment, scope, ciphertext)),
  );
