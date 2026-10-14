import { z } from "zod";
import { deploymentActor } from "./deployment-execution.ts";

export const cloudflareRemovalCommand = z.object({
  kind: z.literal("remove"),
  id: z.uuid(),
  appId: z.uuid(),
  actor: deploymentActor,
  createdAt: z.iso.datetime(),
});

export const removalTarget = z.object({ id: z.uuid(), hostname: z.string() });
