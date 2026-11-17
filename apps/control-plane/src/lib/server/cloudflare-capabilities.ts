import * as contract from "@platform/contracts";
import type { z } from "zod";
import { resolveAppService } from "./app-services.ts";
import type { Transaction } from "./transactions.ts";

export const resolveCloudflareCapabilities = async (
  transaction: Transaction,
  organizationId: string,
  grants: z.infer<typeof contract.capabilityGrants>,
) => {
  const capabilities: Record<string, z.infer<typeof contract.publishedCapability>> = {};

  for (const [name, grant] of Object.entries(grants))
    capabilities[name] = await resolveAppService(transaction, organizationId, grant);

  return capabilities;
};
