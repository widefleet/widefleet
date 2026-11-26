import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { managedApp } from "./apps.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { apps, artifacts, deployments, jobs } from "./schema.ts";
import { transact, type Transaction } from "./transactions.ts";
import type { HostedExecution } from "./deployment-execution.ts";

const present = (app: typeof apps.$inferSelect) =>
  contract.networkState.parse({
    revision: app.networkRevision,
    policy: app.networkPolicy,
    appliedRevision: app.appliedNetworkRevision,
    error: app.networkError,
    state: app.networkError
      ? "failed"
      : !app.activeDeploymentId
        ? "saved"
        : app.appliedNetworkRevision === app.networkRevision
          ? "active"
          : "pending",
  });

// Collaborators see an app's network permissions; only its owner or an administrator changes them.
const mayChange = (
  principal: Pick<Principal, "id" | "application">,
  app: typeof apps.$inferSelect,
) => principal.application.admin || app.ownerId === principal.id;

export const validateNetworkChange = async (
  transaction: Transaction,
  principal: Pick<Principal, "id" | "admin" | "application">,
  appId: string,
) => {
  const access = await managedApp(transaction, principal, appId);

  if (access.isErr()) return access;
  const app = access.value;

  if (!mayChange(principal, app))
    return Result.err(
      new InvalidOperation({
        code: "FORBIDDEN",
        message: "Only the owner or an administrator can change network permissions",
      }),
    );

  if (app.state === "deleting")
    return Result.err(
      new InvalidOperation({ code: "CONFLICT", message: "The app is being deleted" }),
    );

  return Result.ok(app);
};

export const applyNetworkChange = async (
  transaction: Transaction,
  principal: Pick<Principal, "id" | "admin" | "application">,
  appId: string,
  input: z.infer<typeof contract.networkChange>,
  enqueue = true,
) => {
  const access = await validateNetworkChange(transaction, principal, appId);

  if (access.isErr()) return access;
  const app = access.value;
  const policy = contract.networkPolicy.parse(app.networkPolicy);
  const current = policy[input.target];
  const selected = new Set(current);

  for (const origin of input.origins)
    if (input.action === "allow") selected.add(origin);
    else selected.delete(origin);

  policy[input.target] = [...selected].sort();

  const changed =
    current.length !== selected.size || current.some((origin) => !selected.has(origin));

  if (!changed && !app.networkError) return Result.ok(present(app));

  const [updated] = await transaction
    .update(apps)
    .set({
      networkPolicy: policy,
      networkRevision: app.networkRevision + Number(changed),
      networkError: null,
    })
    .where(eq(apps.id, appId))
    .returning();

  if (!updated) throw new Error("Network update returned no row");

  // Resolve the serving deployment at claim time, after earlier execution jobs.
  // Changing permissions must never select an outdated code version.
  if (enqueue)
    await transaction.insert(jobs).values({
      id: crypto.randomUUID(),
      appId,
      organizationId: app.organizationId,
      kind: "configure",
    });

  return Result.ok(present(updated));
};

// The origins the app's latest deployment declares, as the current version.
const declaredNetwork = async (database: DatabaseExecutor, appId: string) => {
  const [latest] = await database
    .select({ metadata: artifacts.metadata })
    .from(deployments)
    .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
    .where(eq(deployments.appId, appId))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(1);

  return latest ? (contract.workerMetadata.parse(latest.metadata).network ?? null) : null;
};

const missing = (wanted: readonly string[], present: readonly string[]) =>
  wanted.filter((origin) => !present.includes(origin));

export const withDeclaration = (
  state: z.infer<typeof contract.networkState>,
  declaration: z.infer<typeof contract.networkDeclaration> | null,
) =>
  declaration
    ? contract.networkState.parse({
        ...state,
        requested: {
          backend: missing(declaration.backend, state.policy.backend),
          browser: missing(declaration.browser, state.policy.browser),
        },
        undeclared: {
          backend: missing(state.policy.backend, declaration.backend),
          browser: missing(state.policy.browser, declaration.browser),
        },
      })
    : state;

const view = (
  database: Database,
  principal: Pick<Principal, "id" | "admin" | "application">,
  appId: string,
) =>
  transact(database, async (transaction) => {
    const app = await managedApp(transaction, principal, appId);

    if (app.isErr()) return app;

    return Result.ok({
      network: withDeclaration(present(app.value), await declaredNetwork(transaction, appId)),
      canManage: app.value.state !== "deleting" && mayChange(principal, app.value),
    });
  });

export const createNetworkService = (database: Database, execution?: HostedExecution) => ({
  read: async (principal: Pick<Principal, "id" | "admin" | "application">, appId: string) => {
    const viewed = await view(database, principal, appId);

    if (viewed.isErr()) return viewed;

    return Result.ok(viewed.value.network);
  },
  // The management page also needs to know whether to offer changes.
  view: (principal: Pick<Principal, "id" | "admin" | "application">, appId: string) =>
    view(database, principal, appId),
  change: async (
    principal: Pick<Principal, "id" | "admin" | "application">,
    appId: string,
    input: z.infer<typeof contract.networkChange>,
  ) => {
    const changed = await (execution
      ? execution.network(principal, appId, input)
      : transact(database, (transaction) =>
          applyNetworkChange(transaction, principal, appId, input),
        ));

    if (changed.isErr()) return changed;

    return Result.ok(withDeclaration(changed.value, await declaredNetwork(database, appId)));
  },
});
