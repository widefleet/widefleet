import { z } from "zod";
import { appAccessGroup } from "./app-access.ts";

export const appRole = z.enum(["user", "developer", "admin", "owner"]);

export const appAction = z.enum([
  "use",
  "read",
  "logs",
  "deploy",
  "rollback",
  "migrate",
  "workflows",
  "roles",
  "network",
  "catalog",
  "delete",
  "transfer",
]);

export const appPrincipal = z.strictObject({
  type: z.enum(["user", "group"]),
  provider: z.string().min(1).max(512),
  subject: appAccessGroup,
});

export const appRoleAssignment = z.strictObject({
  id: z.uuid(),
  principal: appPrincipal,
  role: appRole,
});

export const appRoleGrant = z.strictObject({
  principal: appPrincipal,
  role: appRole.exclude(["owner"]),
  revision: z.number().int().nonnegative(),
});

export const appRoleRevoke = z.strictObject({
  assignmentId: z.uuid(),
  revision: z.number().int().nonnegative(),
});

export const appOwnershipTransfer = z.strictObject({
  principal: appPrincipal,
  revision: z.number().int().nonnegative(),
});

export const appRoleState = z.strictObject({
  appId: z.uuid(),
  inheritedFrom: z.uuid().nullable(),
  revision: z.number().int().nonnegative(),
  assignments: z.array(appRoleAssignment),
  actions: z.array(appAction),
  provider: z.string(),
});
