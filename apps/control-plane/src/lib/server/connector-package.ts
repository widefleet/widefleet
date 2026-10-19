import * as contract from "@platform/contracts";
import { z } from "zod";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";
import { loadPackage, storePackage, verifyModules } from "./package-storage.ts";
import { prepareModules, storeModules } from "./worker-modules.ts";
import type { ArtifactStorage } from "./storage.ts";

export const connectorReference = z.strictObject({
  name: contract.appSlug,
  checksum: contract.checksum,
  entrypoints: contract.connectorPackage.shape.entrypoints,
  classes: z.array(z.string()),
  // Ciphertexts belong to the activation snapshot, independently of login settings.
  secrets: z.record(contract.connectorSecretName, z.string().min(1)).default({}),
  secretRevision: z.number().int().nonnegative().default(0),
});

export const validateConnectorSecret = (value: string) => {
  const result = contract.connectorSecretValue.safeParse(value);

  if (!result.success)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: result.error.issues[0]?.message ?? "Invalid connector secret value",
    });
};

export const validateConnectorEnvironment = (
  configuration: z.infer<typeof contract.connectorConfiguration>,
  secretNames: string[],
) => {
  const variables = contract.connectorConfiguration.shape.vars.safeParse(configuration.vars);

  if (!variables.success)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: variables.error.issues[0]?.message ?? "Invalid connector variables",
    });

  if (
    Object.keys(variables.data).length + secretNames.length >
    contract.connectorEnvironmentMaxBindings
  )
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Connectors support at most 128 variables and secrets combined",
    });
};

const connectorModules = (release: z.infer<typeof contract.connectorPackage>) =>
  release.modules.map(({ source, name, type }) => ({
    name,
    type,
    bytes: new TextEncoder().encode(source),
  }));

export const validateConnectorPackage = (
  release: z.infer<typeof contract.connectorPackage>,
  secretNames: string[],
) => {
  verifyModules(release);
  const prepared = prepareModules(release.main, connectorModules(release), release.debug);

  if (prepared.isErr()) throw prepared.error;
  validateConnectorEnvironment(release.configuration, secretNames);

  if (release.modules.some((module) => module.name.startsWith("__widefleet_")))
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Connector module name is reserved",
    });
};

const connectorArtifact = z.strictObject({
  fleetId: contract.identifier,
  release: contract.storedConnectorPackage,
});

export const connectorModuleScope = (fleetId: string, name: string) =>
  `connectors/${fleetId}/${name}`;

export const saveConnector = async (
  storage: ArtifactStorage,
  fleetId: string,
  release: z.infer<typeof contract.connectorPackage>,
) => {
  verifyModules(release);
  const modules = connectorModules(release);
  const prepared = prepareModules(release.main, modules, release.debug);

  if (prepared.isErr()) throw prepared.error;
  const stored = await storeModules(storage, connectorModuleScope(fleetId, release.name), modules);

  if (stored.isErr()) throw stored.error;

  const artifact = connectorArtifact.parse({
    fleetId,
    release: { ...release, modules: prepared.value },
  });

  return storePackage(storage, Buffer.from(JSON.stringify(artifact)));
};

export const loadConnectorArtifact = async (
  storage: ArtifactStorage,
  reference: Pick<z.infer<typeof connectorReference>, "checksum" | "name">,
) => {
  const value = connectorArtifact.parse(await loadPackage(storage, reference.checksum));

  if (value.release.name !== reference.name)
    throw new StorageUnavailable({ message: "Connector artifact identity mismatch", cause: null });

  return value;
};

export const loadConnector = async (
  storage: ArtifactStorage,
  reference: Pick<z.infer<typeof connectorReference>, "checksum" | "name">,
) => {
  const { fleetId, release } = await loadConnectorArtifact(storage, reference);
  const modules = [];

  for (const module of release.modules) {
    const bytes = await storage.get(
      `${connectorModuleScope(fleetId, release.name)}/modules/${module.sha256}`,
    );

    if (bytes.isErr()) throw bytes.error;
    modules.push({
      name: module.name,
      type: module.type,
      sha256: module.sha256,
      source: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.value),
    });
  }

  const value = { ...release, modules };
  verifyModules(value);

  return value;
};
