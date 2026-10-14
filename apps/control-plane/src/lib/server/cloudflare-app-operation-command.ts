import * as contract from "@platform/contracts";
import { z } from "zod";
import { cloudflareRemovalCommand } from "./cloudflare-removal-command.ts";
import { deploymentActor } from "./deployment-execution.ts";

const command = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  createdAt: z.iso.datetime(),
  actor: deploymentActor,
});

export const cloudflareAppOperation = z.discriminatedUnion("kind", [
  cloudflareRemovalCommand,
  command.extend({ kind: z.literal("migrations"), migration: contract.migrationArtifact }),
  command.extend({ kind: z.literal("workflows"), request: contract.workflowRequest }),
]);
