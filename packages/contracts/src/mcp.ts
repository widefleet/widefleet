import { z } from "zod";
import { organizationIdentifier } from "./organizations.ts";
import { appCaller } from "./app-caller.ts";
import { appAccessGroup } from "./app-access.ts";

export const mcpScopes = ["mcp:services"];

export const mcpIdentity = appCaller.extend({
  name: z.string().max(4096),
  groups: z.array(appAccessGroup),
});

export const mcpClaims = z.object({
  sub: z.string().min(1),
  scope: z.string(),
  exp: z.number().int(),
  mcp: z.object({ organizationId: organizationIdentifier, identity: mcpIdentity }),
});

export const mcpServiceCall = z.strictObject({
  hostname: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]*$/)
    .max(253),
  entrypoint: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
    .max(128),
  method: z.string().min(1).max(128),
  arguments: z.array(z.json()).max(32),
});
