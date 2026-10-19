import * as contract from "@platform/contracts";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { connectorReference } from "./connector-package.ts";
import { InvalidOperation } from "./errors.ts";
import { connectors } from "./schema.ts";
import type { Transaction } from "./transactions.ts";

export const resolveCloudflareCapabilities = async (
  transaction: Transaction,
  fleetId: string,
  grants: z.infer<typeof contract.capabilityGrants>,
) => {
  const capabilities: Record<string, z.infer<typeof contract.publishedCapability>> = {};

  for (const [name, grant] of Object.entries(grants)) {
    const [record] = await transaction
      .select()
      .from(connectors)
      .where(and(eq(connectors.fleetId, fleetId), eq(connectors.name, grant.connector)));

    const active = record?.appliedPackage ? connectorReference.parse(record.appliedPackage) : null;

    if (
      !record ||
      !active?.entrypoints.includes(grant.entrypoint) ||
      !connectorReference.parse(record.package).entrypoints.includes(grant.entrypoint)
    )
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "Deploy the connector entrypoint successfully before binding it",
      });
    capabilities[name] = { ...grant, fleetId };
  }

  return capabilities;
};
