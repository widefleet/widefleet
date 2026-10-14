import * as contract from "@platform/contracts";
import { z } from "zod";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";
import { loadPackage } from "./package-storage.ts";
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

export const loadConnector = async (
  storage: ArtifactStorage,
  reference: z.infer<typeof connectorReference>,
) => {
  const value = contract.connectorPackage.parse(await loadPackage(storage, reference.checksum));

  if (value.name !== reference.name)
    throw new StorageUnavailable({ message: "Connector artifact identity mismatch", cause: null });

  return value;
};
