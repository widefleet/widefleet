import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { z } from "zod";
import { lockAppDescendants } from "./apps.ts";
import { appActions, managedApp } from "./app-permissions.ts";
import type { Configuration } from "./config.ts";
import { providerIssuer, companyAccountProvider } from "./company-identity.ts";
import { readCompanyClaims } from "./company-claims.ts";
import { findMembers } from "./member-directory.ts";
import { account, member } from "./auth-schema.ts";
import { installationOrganizationId } from "../organization.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { appRoleAssignments, apps, jobs } from "./schema.ts";
import { transact, type Transaction } from "./transactions.ts";

const status = (app: typeof apps.$inferSelect) =>
  contract.appAccessStatus.parse({
    revision: app.accessRevision,
    groups: app.accessGroups,
    users: app.accessUsers,
    provider: app.accessProvider,
    allAuthenticated: app.allAuthenticated,
    appliedRevision: app.appliedAccessRevision,
    state: app.accessError
      ? "failed"
      : !app.activeDeploymentId
        ? "saved"
        : app.appliedAccessRevision === app.accessRevision
          ? "active"
          : "pending",
    error: app.accessError,
  });

const present = async (
  transaction: Transaction,
  principal: Principal,
  app: typeof apps.$inferSelect,
) => {
  const previews = app.parentId
    ? []
    : await transaction
        .select()
        .from(apps)
        .where(and(eq(apps.parentId, app.id), ne(apps.state, "deleting")))
        .orderBy(apps.hostname);

  const actions = await appActions(transaction, principal, app.parentId ?? app.id);

  return contract.appAccessState.parse({
    ...status(app),
    inheritedFrom: app.parentId,
    canManage: app.parentId === null && actions.includes("roles"),
    previews: previews.map((preview) => ({
      ...status(preview),
      appId: preview.id,
      hostname: preview.hostname,
    })),
  });
};

const writable = (app: typeof apps.$inferSelect, revision: number) => {
  if (app.parentId !== null)
    return Result.err(
      new InvalidOperation({
        code: "FORBIDDEN",
        message: "Change permissions on the original app; previews inherit them",
      }),
    );

  if (app.state === "deleting")
    return Result.err(
      new InvalidOperation({ code: "CONFLICT", message: "The app is being deleted" }),
    );

  if (app.accessRevision !== revision)
    return Result.err(
      new InvalidOperation({
        code: "CONFLICT",
        message: "Permissions have changed. Reload before saving again.",
      }),
    );

  return Result.ok(app);
};

const assignments = (transaction: Transaction, rootId: string) =>
  transaction
    .select()
    .from(appRoleAssignments)
    .where(eq(appRoleAssignments.appId, rootId))
    .orderBy(appRoleAssignments.role, appRoleAssignments.provider, appRoleAssignments.subject);

const projectAccess = async (
  transaction: Transaction,
  app: typeof apps.$inferSelect,
  provider: string,
  revision = app.accessRevision + 1,
) => {
  const roles = await assignments(transaction, app.id);
  const current = roles.filter((role) => role.provider === provider);

  const rules = contract.appAccessSnapshot.safeParse({
    revision,
    provider,
    users: [
      ...new Set(current.filter((role) => role.type === "user").map((role) => role.subject)),
    ].sort(),
    groups: [
      ...new Set(current.filter((role) => role.type === "group").map((role) => role.subject)),
    ].sort(),
    allAuthenticated: app.allAuthenticated,
  });

  if (!rules.success)
    return Result.err(
      new InvalidOperation({
        code: "BAD_REQUEST",
        message: "An app supports up to 100 people and 100 groups",
      }),
    );
  const descendants = await lockAppDescendants(transaction, app.id);

  const values = {
    accessRevision: rules.data.revision,
    accessProvider: rules.data.provider,
    accessUsers: rules.data.users,
    accessGroups: rules.data.groups,
    allAuthenticated: rules.data.allAuthenticated,
    accessError: null,
  };

  for (const target of [app, ...descendants]) {
    if (target.state === "deleting") continue;
    await transaction.update(apps).set(values).where(eq(apps.id, target.id));

    const [deployment] = await transaction
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.appId, target.id),
          eq(jobs.kind, "deploy"),
          inArray(jobs.state, ["queued", "running"]),
        ),
      );

    if (target.activeDeploymentId || deployment)
      await transaction.insert(jobs).values({
        id: crypto.randomUUID(),
        appId: target.id,
        fleetId: target.fleetId,
        kind: "configure",
      });
  }

  return Result.ok({ ...app, ...values });
};

export const createAppAccessService = (database: Database, configuration: Configuration) => {
  const provider = () =>
    configuration.IDENTITY ? providerIssuer(configuration.IDENTITY.provider) : "";

  const roleState = async (
    transaction: Transaction,
    principal: Principal,
    app: typeof apps.$inferSelect,
  ) => {
    const rootId = app.parentId ?? app.id;

    return contract.appRoleState.parse({
      appId: app.id,
      inheritedFrom: app.parentId,
      revision: app.accessRevision,
      assignments: (await assignments(transaction, rootId)).map(
        ({ id, type, provider, subject, role }) => ({
          id,
          principal: { type, provider, subject },
          role,
        }),
      ),
      actions: await appActions(transaction, principal, rootId),
      provider: provider(),
    });
  };

  const memberPrincipal = async (transaction: Transaction, userId: string) => {
    const [linked] = configuration.IDENTITY
      ? await transaction
          .select()
          .from(account)
          .where(
            and(
              eq(account.userId, userId),
              eq(account.providerId, companyAccountProvider(configuration.IDENTITY)),
            ),
          )
      : [];

    const claims =
      linked && configuration.IDENTITY
        ? readCompanyClaims(configuration.IDENTITY.provider, linked)
        : undefined;

    return contract.appPrincipal.parse({
      type: "user",
      provider: claims?.provider ?? "widefleet",
      subject: claims?.subject ?? userId,
    });
  };

  const validatePrincipal = async (
    transaction: Transaction,
    target: z.infer<typeof contract.appPrincipal>,
  ) => {
    if (target.provider === "widefleet" && target.type === "user") {
      const [person] = await transaction
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.userId, target.subject),
            eq(member.organizationId, installationOrganizationId),
          ),
        );

      if (person) return Result.ok(await memberPrincipal(transaction, target.subject));

      return Result.err(
        new InvalidOperation({ code: "NOT_FOUND", message: "An active company user is required" }),
      );
    } else if (target.provider === provider()) return Result.ok(target);

    return Result.err(
      new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Choose a current company identity or an existing member",
      }),
    );
  };

  const mutateRoles = (
    principal: Principal,
    appId: string,
    revision: number,
    action: "roles" | "transfer",
    mutate: (transaction: Transaction) => Promise<Result<null, InvalidOperation>>,
  ) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId, action);

      if (access.isErr()) return access;
      const valid = writable(access.value, revision);

      if (valid.isErr()) return valid;
      const changed = await mutate(transaction);

      if (changed.isErr()) return changed;
      const updated = await projectAccess(transaction, access.value, provider());

      if (updated.isErr()) return updated;

      return Result.ok(await roleState(transaction, principal, updated.value));
    });

  return {
    read: (principal: Principal, appId: string) =>
      transact(database, async (transaction) => {
        const access = await managedApp(transaction, principal, appId);

        if (access.isErr()) return access;

        return Result.ok(await present(transaction, principal, access.value));
      }),
    roles: (principal: Principal, appId: string) =>
      transact(database, async (transaction) => {
        const access = await managedApp(transaction, principal, appId);

        if (access.isErr()) return access;

        return Result.ok(await roleState(transaction, principal, access.value));
      }),
    candidates: (principal: Principal, appId: string, search: string) =>
      transact(database, async (transaction) => {
        const access = await managedApp(transaction, principal, appId, "roles");

        if (access.isErr()) return access;
        const people = [];

        for (const person of await findMembers(transaction, search)) {
          people.push({
            name: person.name,
            email: person.email,
            principal: await memberPrincipal(transaction, person.userId),
          });
        }

        return Result.ok(people);
      }),
    grant: (principal: Principal, appId: string, input: z.infer<typeof contract.appRoleGrant>) =>
      mutateRoles(principal, appId, input.revision, "roles", async (transaction) => {
        const valid = await validatePrincipal(transaction, input.principal);

        if (valid.isErr()) return valid;
        await transaction
          .insert(appRoleAssignments)
          .values({ id: crypto.randomUUID(), appId, ...valid.value, role: input.role })
          .onConflictDoNothing();

        return Result.ok(null);
      }),
    revoke: (principal: Principal, appId: string, input: z.infer<typeof contract.appRoleRevoke>) =>
      mutateRoles(principal, appId, input.revision, "roles", async (transaction) => {
        const [assignment] = await transaction
          .select()
          .from(appRoleAssignments)
          .where(
            and(eq(appRoleAssignments.id, input.assignmentId), eq(appRoleAssignments.appId, appId)),
          );

        if (!assignment)
          return Result.err(
            new InvalidOperation({ code: "NOT_FOUND", message: "Role assignment not found" }),
          );

        if (assignment.role === "owner")
          return Result.err(
            new InvalidOperation({
              code: "FORBIDDEN",
              message: "Transfer ownership to replace the owner",
            }),
          );
        await transaction
          .delete(appRoleAssignments)
          .where(eq(appRoleAssignments.id, assignment.id));

        return Result.ok(null);
      }),
    transfer: (
      principal: Principal,
      appId: string,
      input: z.infer<typeof contract.appOwnershipTransfer>,
    ) =>
      mutateRoles(principal, appId, input.revision, "transfer", async (transaction) => {
        const valid = await validatePrincipal(transaction, input.principal);

        if (valid.isErr()) return valid;
        await transaction
          .update(appRoleAssignments)
          .set(valid.value)
          .where(and(eq(appRoleAssignments.appId, appId), eq(appRoleAssignments.role, "owner")));

        return Result.ok(null);
      }),
    change: (
      principal: Principal,
      appId: string,
      input: z.infer<typeof contract.appAccessChange>,
    ) =>
      transact(database, async (transaction) => {
        const access = await managedApp(transaction, principal, appId, "roles");

        if (access.isErr()) return access;
        const valid = writable(access.value, input.revision);

        if (valid.isErr()) return valid;

        const updated = await projectAccess(
          transaction,
          { ...access.value, allAuthenticated: input.allAuthenticated },
          provider(),
          access.value.accessRevision +
            Number(
              input.allAuthenticated !== access.value.allAuthenticated ||
                access.value.accessProvider !== provider(),
            ),
        );

        if (updated.isErr()) return updated;

        return Result.ok(await present(transaction, principal, updated.value));
      }),
  };
};
