import type * as contract from "@platform/contracts";
import type { z } from "zod";
import type { createCloudflareProvisioner } from "./cloudflare-provisioning.ts";

export const provisionConnectorResources = (
  provisioner: ReturnType<typeof createCloudflareProvisioner>,
  organizationId: string,
  release: z.infer<typeof contract.connectorPackage>,
) =>
  provisioner.provisionWorker(
    `${organizationId}/connector/${release.name}`,
    release.metadata.bindings,
  );
