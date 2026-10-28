import { createHash } from "node:crypto";
import * as contract from "@platform/contracts";
import { z } from "zod";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";
import { loadPackage, storePackage } from "./package-storage.ts";
import { prepareModules, storeModules, type WorkerModule } from "./worker-modules.ts";
import type { ArtifactStorage } from "./storage.ts";

export const connectorReference = z.strictObject({
  name: contract.appSlug,
  checksum: contract.checksum,
  entrypoints: contract.connectorUploadMetadata.shape.entrypoints,
  browserEntrypoints: z.array(contract.bindingName).default([]),
  classes: z.array(z.string()),
  // Ciphertexts belong to the activation snapshot, independently of login settings.
  secrets: z.record(contract.connectorSecretName, z.string().min(1)).default({}),
  secretRevision: z.number().int().nonnegative().default(0),
});

export const uploadedConnector = (
  name: string,
  metadata: z.infer<typeof contract.connectorUploadMetadata>,
  modules: WorkerModule[],
) =>
  prepareModules(metadata.main_module, modules, metadata.debug).map((references) =>
    contract.connectorPackage.parse({ protocol: 1, name, metadata, modules: references }),
  );

export const validateConnectorSecret = (value: string) => {
  const result = contract.connectorSecretValue.safeParse(value);

  if (!result.success)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: result.error.issues[0]?.message ?? "Invalid connector secret value",
    });
};

export const validateConnectorPackage = (
  release: z.infer<typeof contract.connectorPackage>,
  secretNames: string[],
) => {
  const valid = contract.connectorPackage.safeParse(release);

  if (!valid.success)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: valid.error.issues[0]?.message ?? "Invalid worker configuration",
    });

  if (
    release.metadata.bindings.filter((binding) => binding.type === "plain_text").length +
      secretNames.length >
    contract.connectorEnvironmentMaxBindings
  )
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Connectors support at most 128 variables and secrets combined",
    });
};

const connectorArtifact = z.strictObject({
  organizationId: contract.organizationIdentifier,
  release: contract.connectorPackage,
});

const artifactBytes = (
  organizationId: string,
  release: z.infer<typeof contract.connectorPackage>,
) => Buffer.from(JSON.stringify(connectorArtifact.parse({ organizationId, release })));

export const connectorChecksum = (
  organizationId: string,
  release: z.infer<typeof contract.connectorPackage>,
) => createHash("sha256").update(artifactBytes(organizationId, release)).digest("hex");

export const connectorModuleScope = (organizationId: string, name: string) =>
  `connectors/${organizationId}/${name}`;

export const saveConnector = async (
  storage: ArtifactStorage,
  organizationId: string,
  release: z.infer<typeof contract.connectorPackage>,
  modules?: WorkerModule[],
) => {
  if (modules) {
    const prepared = prepareModules(release.metadata.main_module, modules, release.metadata.debug);

    if (prepared.isErr()) throw prepared.error;

    if (JSON.stringify(prepared.value) !== JSON.stringify(release.modules))
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Worker module references do not match uploaded files",
      });

    const stored = await storeModules(
      storage,
      connectorModuleScope(organizationId, release.name),
      modules,
    );

    if (stored.isErr()) throw stored.error;
  }

  return storePackage(storage, artifactBytes(organizationId, release));
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
) => (await loadConnectorArtifact(storage, reference)).release;
