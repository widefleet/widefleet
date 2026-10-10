import { appAction, appPrincipal } from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, exists, inArray, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { rolesForAction } from "../app-roles.ts";
import type { DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { appRoleAssignments, apps } from "./schema.ts";
import type { Transaction } from "./transactions.ts";

export const personalPrincipal = (principal: Principal) =>
  appPrincipal.parse(
    principal.company
      ? { type: "user", provider: principal.company.provider, subject: principal.company.subject }
      : { type: "user", provider: "widefleet", subject: principal.id },
  );

export const matchingPrincipal = (principal: Principal) =>
  or(
    and(
      eq(appRoleAssignments.type, "user"),
      eq(appRoleAssignments.provider, "widefleet"),
      eq(appRoleAssignments.subject, principal.id),
    ),
    principal.company
      ? and(
          eq(appRoleAssignments.provider, principal.company.provider),
          or(
            and(
              eq(appRoleAssignments.type, "user"),
              eq(appRoleAssignments.subject, principal.company.subject),
            ),
            principal.company.groups.length
              ? and(
                  eq(appRoleAssignments.type, "group"),
                  inArray(appRoleAssignments.subject, principal.company.groups),
                  sql`${principal.company.expiresAt} > extract(epoch from clock_timestamp()) * 1000`,
                )
              : sql`false`,
          ),
        )
      : sql`false`,
  );

export const appVisibility = (
  database: DatabaseExecutor,
  principal: Principal,
  action: z.infer<typeof appAction> = "read",
) =>
  principal.admin && action !== "use"
    ? sql`true`
    : exists(
        database
          .select({ id: appRoleAssignments.id })
          .from(appRoleAssignments)
          .where(
            and(
              eq(appRoleAssignments.appId, sql`coalesce(${apps.parentId}, ${apps.id})`),
              matchingPrincipal(principal),
              inArray(appRoleAssignments.role, rolesForAction(action)),
            ),
          ),
      );

export const appActions = async (
  database: DatabaseExecutor,
  principal: Principal,
  rootId: string,
) => {
  const assignments = await database
    .select({ role: appRoleAssignments.role, type: appRoleAssignments.type })
    .from(appRoleAssignments)
    .where(and(eq(appRoleAssignments.appId, rootId), matchingPrincipal(principal)));

  return appAction.options.filter(
    (action) =>
      (principal.admin && action !== "use") ||
      assignments.some(
        ({ role, type }) =>
          (type !== "group" || (principal.company?.expiresAt ?? 0) > Date.now()) &&
          rolesForAction(action).includes(role),
      ),
  );
};

export const managedApp = async (
  transaction: Transaction,
  principal: Principal,
  appId: string,
  action: z.infer<typeof appAction> = "read",
) => {
  const [target] = await transaction
    .select({ parentId: apps.parentId })
    .from(apps)
    .where(eq(apps.id, appId));

  if (!target)
    return Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App not found" }));

  // Lock the authorization root first, so a concurrent role change
  // cannot race a mutation of either the original app or one of its previews.
  const [root] = await transaction
    .select()
    .from(apps)
    .where(and(eq(apps.id, target.parentId ?? appId), appVisibility(transaction, principal)))
    .for("update");

  if (!root)
    return Result.err(
      new InvalidOperation(
        principal.company && principal.company.expiresAt <= Date.now()
          ? {
              code: "FORBIDDEN",
              message:
                "Company group information has expired. Renew your company sign-in to use group permissions.",
            }
          : { code: "NOT_FOUND", message: "App not found" },
      ),
    );

  const [preview] =
    target.parentId === null
      ? [root]
      : await transaction
          .select()
          .from(apps)
          .where(and(eq(apps.id, appId), eq(apps.parentId, root.id)))
          .for("update");

  // The issuer's deadline may have passed while either row lock was pending.
  if (!(await appActions(transaction, principal, root.id)).includes(action))
    return Result.err(
      new InvalidOperation({ code: "FORBIDDEN", message: `App permission required: ${action}` }),
    );

  return preview
    ? Result.ok(preview)
    : Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App not found" }));
};
