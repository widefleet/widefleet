import type * as contract from "@platform/contracts";
import type { z } from "zod";
import type { createCloudflareProvisioner } from "./cloudflare-provisioning.ts";

export const provisionConnectorResources = (
  provisioner: ReturnType<typeof createCloudflareProvisioner>,
  fleetId: string,
  release: z.infer<typeof contract.connectorPackage>,
) => provisioner.provisionWorker(`${fleetId}/connector/${release.name}`, release.metadata.bindings);
