import { z } from "zod";
import { deploymentCommand } from "./deployment-execution.ts";
import { cloudflareRuntimeCommand } from "./cloudflare-runtime-command.ts";

export const deploymentWorkflowCommand = z.union([deploymentCommand, cloudflareRuntimeCommand]);
