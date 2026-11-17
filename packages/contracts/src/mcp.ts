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
