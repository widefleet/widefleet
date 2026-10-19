import {
  connectorPreparation,
  connectorActivation,
  storedConnectorPackage,
  checksum,
} from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";

export const connectorGeneration = connectorActivation.extend({
  sequence: z.number().int().positive(),
});

export const connectorSnapshot = connectorPreparation.omit({ secrets: true }).extend({
  release: storedConnectorPackage,
  ciphertext: z.string(),
  fingerprint: checksum,
  previous: z.string().nullable(),
});

export const connectorScope = (identity: { fleetId: string; name: string }) =>
  `connectors/${identity.fleetId}/${identity.name}`;

export const connectorKey = (identity: z.infer<typeof connectorActivation>) =>
  `${connectorScope(identity)}/versions/${identity.version}.json`;

export const digest = async (value: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

const key = async (environment: Pick<ParentEnvironment, "WIDEFLEET_CONNECTOR_KEY">) =>
  crypto.subtle.importKey(
    "raw",
    Uint8Array.from(
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(environment.WIDEFLEET_CONNECTOR_KEY)
        .match(/../g) ?? [],
      (byte) => Number.parseInt(byte, 16),
    ),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

const associatedData = (identity: z.infer<typeof connectorActivation>) =>
  new TextEncoder().encode(connectorKey(identity));

export const encryptConnectorSecrets = async (
  environment: Pick<ParentEnvironment, "WIDEFLEET_CONNECTOR_KEY">,
  identity: z.infer<typeof connectorActivation>,
  secrets: z.infer<typeof connectorPreparation>["secrets"],
) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: associatedData(identity) },
      await key(environment),
      new TextEncoder().encode(JSON.stringify(secrets)),
    ),
  );

  return btoa(
    Array.from(iv, (byte) => String.fromCharCode(byte)).join("") +
      Array.from(encrypted, (byte) => String.fromCharCode(byte)).join(""),
  );
};

export const decryptConnectorSecrets = async (
  environment: Pick<ParentEnvironment, "WIDEFLEET_CONNECTOR_KEY">,
  identity: z.infer<typeof connectorActivation>,
  ciphertext: string,
) => {
  const bytes = Uint8Array.from(atob(ciphertext), (character) => character.charCodeAt(0));

  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: associatedData(identity) },
    await key(environment),
    bytes.slice(12),
  );

  return connectorPreparation.shape.secrets.parse(JSON.parse(new TextDecoder().decode(data)));
};

export const readConnector = async (
  environment: ParentEnvironment,
  identity: z.infer<typeof connectorActivation>,
) => {
  const object = await environment.WIDEFLEET_PACKAGES.get(connectorKey(identity));

  if (!object) throw new Error("Connector version is not published");
  const snapshot = connectorSnapshot.parse(await object.json());

  if (
    snapshot.fleetId !== identity.fleetId ||
    snapshot.release.name !== identity.name ||
    snapshot.version !== identity.version
  )
    throw new Error("Connector snapshot identity mismatch");

  return snapshot;
};
