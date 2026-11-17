import { z } from "zod";
import { organizationIdentifier } from "./organizations.ts";
import { serviceUser } from "./service-grants.ts";
import { appAccessGroups } from "./app-access.ts";

export const mcpScopes = ["mcp:services"];

export const mcpIdentity = serviceUser.extend({
  name: z.string().max(4096),
  groups: appAccessGroups,
});

export const mcpClaims = z.object({
  sub: z.string().min(1),
  scope: z.string(),
  exp: z.number().int(),
  mcp: z.object({ organizationId: organizationIdentifier, identity: mcpIdentity }),
});
