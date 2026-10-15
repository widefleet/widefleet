import { z } from "zod";
import { deploymentActor } from "./deployment-execution.ts";
import { runtimeReference } from "./runtime-releases.ts";

export const cloudflareRuntimeCommand = z.object({
  kind: z.literal("runtime"),
  id: z.uuid(),
  fleetId: z.uuid(),
  previousJobId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  actor: deploymentActor,
  runtime: runtimeReference,
  rollback: z.boolean(),
});
