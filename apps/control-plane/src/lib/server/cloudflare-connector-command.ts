import * as contract from "@platform/contracts";
import { z } from "zod";
import { deploymentActor, deploymentCommand } from "./deployment-execution.ts";
import { cloudflareRuntimeCommand } from "./cloudflare-runtime-command.ts";

export const connectorCommand = z.object({
  kind: z.literal("connector"),
  id: z.uuid(),
  fleetId: z.uuid(),
  createdAt: z.iso.datetime(),
  actor: deploymentActor,
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("deploy"), name: contract.appSlug, checksum: contract.checksum }),
    z.object({
      kind: z.literal("secret"),
      name: contract.appSlug,
      secret: contract.connectorSecretName,
      ciphertext: z.string().min(1).nullable(),
    }),
  ]),
});

export const deploymentWorkflowCommand = z.union([
  deploymentCommand,
  connectorCommand,
  cloudflareRuntimeCommand,
]);
