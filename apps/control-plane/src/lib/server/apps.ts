import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, desc, eq, exists, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import { member, user } from "./auth-schema.ts";
import { installationOrganizationId } from "../organization.ts";
import { findMembers } from "./member-directory.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { appGrants, apps, artifacts, deploymentEvents, deployments, jobs } from "./schema.ts";
import { transact, type Transaction } from "./transactions.ts";
import { defaultFleet } from "./fleets.ts";

export const appVisibility = (database: Database | Transaction, principal: Principal) =>
  principal.admin
    ? sql`true`
    : or(
        eq(apps.ownerId, principal.id),
        exists(
          database
            .select({ id: appGrants.appId })
            .from(appGrants)
            .where(and(eq(appGrants.appId, apps.id), eq(appGrants.userId, principal.id))),
        ),
      );

export const managedApp = async (transaction: Transaction, principal: Principal, appId: string) => {
  const [record] = await transaction
    .select()
    .from(apps)
    .where(and(eq(apps.id, appId), appVisibility(transaction, principal)))
    .for("update");

  if (!record)
    return Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App not found" }));

  return Result.ok(record);
};

// The caller holds the root app lock. All tree mutations lock descendants from parent
// to child, including access inheritance and removal of a legacy preview subtree.
export const lockAppDescendants = async (transaction: Transaction, appId: string) => {
  let parents = [appId];
  const descendants = [];

  while (parents.length > 0) {
    const level = await transaction
      .select()
      .from(apps)
      .where(inArray(apps.parentId, parents))
      .orderBy(apps.id)
      .for("update");

    descendants.push(...level);
    parents = level.map((app) => app.id);
  }

  return descendants;
};

export const enqueueAppRemoval = async (
  transaction: Transaction,
  record: typeof apps.$inferSelect,
) => {
  const descendants = await lockAppDescendants(transaction, record.id);
  const pending = [record, ...descendants].filter((app) => app.state !== "deleting");

  if (pending.length === 0) return;

  await transaction
    .update(apps)
    .set({ state: "deleting" })
    .where(
      inArray(
        apps.id,
        pending.map((app) => app.id),
      ),
    );
  // Existing work finishes first; descendants are torn down before their parents per fleet.
  await transaction.insert(jobs).values(
    pending.toReversed().map((app) => ({
      id: crypto.randomUUID(),
      appId: app.id,
      fleetId: app.fleetId,
      kind: "delete" as const,
    })),
  );
};

export const appUrl = (hostname: string, port: number) => {
  const url = new URL(`https://${hostname}`);
  url.port = String(port);

  return url.href;
};

export const presentApp = (record: typeof apps.$inferSelect, configuration: Configuration) =>
  contract.app.parse({
    id: record.id,
    slug: record.slug,
    displayName: record.displayName,
    catalogListed: record.catalogListed,
    parentId: record.parentId,
    fleetId: record.fleetId,
    hostname: record.hostname,
    url: appUrl(record.hostname, configuration.APP_HTTPS_PORT),
    state: record.state,
    activeDeploymentId: record.activeDeploymentId,
    createdAt: record.createdAt.toISOString(),
  });

export const presentDeployment = (record: typeof deployments.$inferSelect) =>
  contract.deployment.parse({
    id: record.id,
    appId: record.appId,
    artifactId: record.artifactId,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString() ?? null,
    message: record.message,
  });

export const enqueueDeployment = async (
  transaction: Transaction,
  record: typeof apps.$inferSelect,
  artifactId: string,
  requestId: string,
  rollback = false,
) => {
  const [existing] = await transaction
    .select()
    .from(deployments)
    .where(and(eq(deployments.appId, record.id), eq(deployments.requestId, requestId)));

  if (existing) {
    if (existing.artifactId !== artifactId)
      return Result.err(
        new InvalidOperation({
          code: "CONFLICT",
          message: "The request ID already refers to another artifact",
        }),
      );

    return Result.ok(presentDeployment(existing));
  }

  const deploymentId = crypto.randomUUID();

  const [deployment] = await transaction
    .insert(deployments)
    .values({ id: deploymentId, appId: record.id, artifactId, requestId })
    .returning();

  if (!deployment) throw new Error("Deployment insert returned no row");

  await transaction.insert(jobs).values({
    id: crypto.randomUUID(),
    appId: record.id,
    fleetId: record.fleetId,
    deploymentId,
    kind: "deploy",
    rollback,
  });
  await transaction
    .insert(deploymentEvents)
    .values({ deploymentId, level: "info", message: "Deployment queued" });

  return Result.ok(presentDeployment(deployment));
};

const provisionApp = (
  database: Database,
  configuration: Configuration,
  principal: Principal,
  input: z.infer<typeof contract.createAppInput>,
  mode: "create" | "resolve",
) =>
  transact(database, async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.slug}, 0))`,
    );

    const [duplicate] = await transaction
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.slug, input.slug));

    if (!principal.creator && (mode === "create" || !duplicate))
      return Result.err(
        new InvalidOperation({
          code: "FORBIDDEN",
          message: "App creator permission is required",
        }),
      );

    if (duplicate) {
      if (mode === "create")
        return Result.err(
          new InvalidOperation({ code: "CONFLICT", message: "This app name is already in use" }),
        );
      const existing = await managedApp(transaction, principal, duplicate.id);

      if (existing.isErr()) return existing;

      if (existing.value.state === "deleting")
        return Result.err(
          new InvalidOperation({ code: "CONFLICT", message: "The app is being deleted" }),
        );

      return Result.ok(presentApp(existing.value, configuration));
    }

    const fleet = await defaultFleet(transaction);
    let hostname = `${input.slug}.${configuration.APP_DOMAIN}`;
    let accessGroups: string[] = [];
    let accessRevision = 0;

    if (input.previewName !== undefined && input.parentId === null)
      return Result.err(
        new InvalidOperation({
          code: "BAD_REQUEST",
          message: "A named preview requires a parent app",
        }),
      );

    if (input.parentId !== null) {
      const parent = await managedApp(transaction, principal, input.parentId);

      if (parent.isErr()) return parent;

      if (parent.value.state === "deleting")
        return Result.err(
          new InvalidOperation({ code: "CONFLICT", message: "The parent app is being deleted" }),
        );

      if (parent.value.parentId !== null)
        return Result.err(
          new InvalidOperation({
            code: "BAD_REQUEST",
            message: "Choose an original app as the preview parent",
          }),
        );
      accessGroups = contract.appAccessGroups.parse(parent.value.accessGroups);
      accessRevision = parent.value.accessRevision;

      if (input.previewName !== undefined) {
        if (
          parent.value.parentId !== null ||
          parent.value.hostname !== `${parent.value.slug}.${configuration.APP_DOMAIN}`
        )
          return Result.err(
            new InvalidOperation({
              code: "BAD_REQUEST",
              message: "Choose an original app as the preview parent",
            }),
          );

        hostname = `${input.previewName}.${parent.value.hostname}`;

        if (hostname.length > 253)
          return Result.err(
            new InvalidOperation({
              code: "BAD_REQUEST",
              message: "The preview hostname exceeds the DNS length limit",
            }),
          );
      }
    }

    const [record] = await transaction
      .insert(apps)
      .values({
        id: crypto.randomUUID(),
        slug: input.slug,
        displayName: input.displayName,
        parentId: input.parentId,
        accessGroups,
        accessRevision,
        fleetId: fleet.id,
        ownerId: principal.id,
        hostname,
      })
      .onConflictDoNothing()
      .returning();

    if (!record)
      return Result.err(
        new InvalidOperation({
          code: "CONFLICT",
          message: "This app name or preview hostname is already in use",
        }),
      );

    return Result.ok(presentApp(record, configuration));
  });

export const createAppService = (database: Database, configuration: Configuration) => ({
  catalog: () =>
    transact(database, async (transaction) => {
      const records = await transaction
        .select({ id: apps.id, displayName: apps.displayName, hostname: apps.hostname })
        .from(apps)
        .where(
          and(
            eq(apps.catalogListed, true),
            isNull(apps.parentId),
            eq(apps.state, "active"),
            isNotNull(apps.activeDeploymentId),
          ),
        )
        .orderBy(apps.displayName, apps.id);

      return Result.ok(
        records.map((record) => ({
          ...record,
          url: appUrl(record.hostname, configuration.APP_HTTPS_PORT),
        })),
      );
    }),
  setCatalogListing: (principal: Principal, appId: string, listed: boolean) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;
      const record = access.value;

      if (!principal.admin && record.ownerId !== principal.id)
        return Result.err(
          new InvalidOperation({
            code: "FORBIDDEN",
            message: "Only owners and admins can change catalog visibility.",
          }),
        );

      if (
        listed &&
        (record.parentId !== null || record.state !== "active" || !record.activeDeploymentId)
      )
        return Result.err(
          new InvalidOperation({
            code: "CONFLICT",
            message: "Only active apps that are not previews can be published to the catalog.",
          }),
        );

      await transaction.update(apps).set({ catalogListed: listed }).where(eq(apps.id, appId));

      return Result.ok({ listed });
    }),
  list: (principal: Principal) =>
    transact(database, async (transaction) => {
      const records = await transaction
        .select()
        .from(apps)
        .where(appVisibility(transaction, principal))
        .orderBy(apps.slug);

      return Result.ok(records.map((record) => presentApp(record, configuration)));
    }),
  get: (principal: Principal, appId: string) =>
    transact(database, async (transaction) => {
      const record = await managedApp(transaction, principal, appId);

      if (record.isErr()) return record;

      return Result.ok(presentApp(record.value, configuration));
    }),
  create: (principal: Principal, input: z.infer<typeof contract.createAppInput>) =>
    provisionApp(database, configuration, principal, input, "create"),
  resolve: (principal: Principal, slug: string) =>
    provisionApp(
      database,
      configuration,
      principal,
      { slug, displayName: slug, parentId: null },
      "resolve",
    ),
  history: (principal: Principal, appId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      const records = await transaction
        .select()
        .from(deployments)
        .where(eq(deployments.appId, appId))
        .orderBy(desc(deployments.createdAt))
        .limit(100);

      return Result.ok(records.map(presentDeployment));
    }),
  events: (principal: Principal, appId: string, deploymentId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      const [deployment] = await transaction
        .select({ id: deployments.id })
        .from(deployments)
        .where(and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)));

      if (!deployment)
        return Result.err(
          new InvalidOperation({ code: "NOT_FOUND", message: "Deployment not found" }),
        );

      const records = await transaction
        .select()
        .from(deploymentEvents)
        .where(eq(deploymentEvents.deploymentId, deploymentId))
        .orderBy(deploymentEvents.id)
        .limit(500);

      return Result.ok(
        records.map((record) =>
          contract.deploymentEvent.parse({ ...record, createdAt: record.createdAt.toISOString() }),
        ),
      );
    }),
  rollback: (principal: Principal, appId: string, artifactId: string, requestId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      if (access.value.state === "deleting")
        return Result.err(
          new InvalidOperation({ code: "CONFLICT", message: "App is being deleted" }),
        );

      const [artifact] = await transaction
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.appId, appId)));

      if (!artifact)
        return Result.err(
          new InvalidOperation({ code: "NOT_FOUND", message: "Artifact not found in this app" }),
        );

      return enqueueDeployment(transaction, access.value, artifactId, requestId, true);
    }),
  remove: (principal: Principal, appId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      await enqueueAppRemoval(transaction, access.value);

      return Result.ok({ accepted: true });
    }),
  access: (principal: Principal, appId: string, search: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      const canManage = principal.admin || access.value.ownerId === principal.id;

      const [owner] = await transaction
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, access.value.ownerId));

      const grants = await transaction
        .select({ userId: user.id, name: user.name, email: user.email })
        .from(appGrants)
        .innerJoin(user, eq(user.id, appGrants.userId))
        .where(eq(appGrants.appId, appId));

      const candidates = canManage && search ? await findMembers(transaction, search) : [];

      return Result.ok({
        canManage,
        owner: owner ?? null,
        grants,
        candidates: candidates
          .slice(0, 50)
          .filter(
            (person) =>
              person.userId !== access.value.ownerId &&
              !grants.some((grant) => grant.userId === person.userId),
          ),
        hasMore: candidates.length > 50,
      });
    }),
  grant: (principal: Principal, appId: string, userId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      if (!principal.admin && access.value.ownerId !== principal.id)
        return Result.err(
          new InvalidOperation({
            code: "FORBIDDEN",
            message: "Only the owner or an administrator can change app permissions",
          }),
        );

      const [person] = await transaction
        .select({ id: user.id })
        .from(user)
        .innerJoin(
          member,
          and(eq(member.userId, user.id), eq(member.organizationId, installationOrganizationId)),
        )
        .where(eq(user.id, userId));

      if (!person)
        return Result.err(
          new InvalidOperation({
            code: "NOT_FOUND",
            message: "An active company user is required",
          }),
        );

      await transaction.insert(appGrants).values({ appId, userId }).onConflictDoNothing();

      return Result.ok({ granted: true });
    }),
  revoke: (principal: Principal, appId: string, userId: string) =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      if (!principal.admin && access.value.ownerId !== principal.id)
        return Result.err(
          new InvalidOperation({
            code: "FORBIDDEN",
            message: "Only the owner or an administrator can change app permissions",
          }),
        );

      await transaction
        .delete(appGrants)
        .where(and(eq(appGrants.appId, appId), eq(appGrants.userId, userId)));

      return Result.ok({ revoked: true });
    }),
});
