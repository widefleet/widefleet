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

export const encryptSecrets = async (
  environment: Environment,
  scope: string,
  secrets: z.infer<typeof appSecretPreparation>["values"],
) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(scope) },
      await key(environment),
      new TextEncoder().encode(JSON.stringify(secrets)),
    ),
  );

  return btoa(
    Array.from(iv, (byte) => String.fromCharCode(byte)).join("") +
      Array.from(encrypted, (byte) => String.fromCharCode(byte)).join(""),
  );
};

export const decryptSecrets = async (
  environment: Environment,
  scope: string,
  ciphertext: string,
) => {
  const bytes = Uint8Array.from(atob(ciphertext), (character) => character.charCodeAt(0));

  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(scope) },
    await key(environment),
    bytes.slice(12),
  );

  return appSecretPreparation.shape.values.parse(JSON.parse(new TextDecoder().decode(data)));
};
