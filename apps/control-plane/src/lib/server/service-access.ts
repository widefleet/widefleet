import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, desc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { user } from "./auth-schema.ts";
import { apps, connectionRequests } from "./schema.ts";
import {
  applyCapabilityChange,
  organizationAdministrator,
  validateCapabilityChange,
} from "./capability-changes.ts";
import { lockOrganizationRuntime } from "./organization-runtime.ts";
import { InvalidOperation } from "./errors.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import type { HostedExecution } from "./deployment-execution.ts";
import type { Principal } from "./identity.ts";
import { readOnly, transact } from "./transactions.ts";

const readRequests = async (
  transaction: DatabaseExecutor,
  principal: Principal,
  requestId?: string,
) => {
  const service = alias(apps, "service");

  const records = await transaction
    .select({
      request: connectionRequests,
      appName: apps.displayName,
      serviceName: service.displayName,
      requesterName: user.name,
    })
    .from(connectionRequests)
    .innerJoin(apps, eq(apps.id, connectionRequests.appId))
    .innerJoin(service, eq(service.id, connectionRequests.serviceId))
    .innerJoin(user, eq(user.id, connectionRequests.requesterId))
    .where(
      and(
        eq(connectionRequests.organizationId, principal.application.organizationId),
        principal.application.admin ? undefined : eq(connectionRequests.requesterId, principal.id),
        requestId ? eq(connectionRequests.id, requestId) : undefined,
      ),
    )
    .orderBy(desc(connectionRequests.createdAt), connectionRequests.id);

  return records.map(({ request, ...names }) =>
    contract.connectionRequest.parse({
      id: request.id,
      appId: request.appId,
      serviceId: request.serviceId,
      binding: request.binding,
      entrypoint: request.entrypoint,
      requesterId: request.requesterId,
      status: request.status,
      createdAt: request.createdAt.toISOString(),
      ...names,
    }),
  );
};

export const createServiceAccess = (database: Database, execution?: HostedExecution) => ({
  setAccess: (
    principal: Principal,
    appId: string,
    accessMode: z.infer<typeof contract.serviceAccessMode>,
  ) =>
    transact(database, async (transaction) => {
      organizationAdministrator(principal);
      await lockOrganizationRuntime(transaction, principal.application.organizationId);

      const [updated] = await transaction
        .update(apps)
        .set({ serviceAccessMode: accessMode })
        .where(
          and(
            eq(apps.id, appId),
            eq(apps.organizationId, principal.application.organizationId),
            isNull(apps.removedAt),
          ),
        )
        .returning({ accessMode: apps.serviceAccessMode });

      if (!updated) throw new InvalidOperation({ code: "NOT_FOUND", message: "App not found" });

      return Result.ok(updated);
    }),
  requests: (principal: Principal) =>
    readOnly(database, async (transaction) =>
      Result.ok(await readRequests(transaction, principal)),
    ),
  request: (principal: Principal, input: z.infer<typeof contract.connectionRequestInput>) =>
    transact(database, async (transaction) => {
      const valid = await validateCapabilityChange(
        transaction,
        principal,
        input.appId,
        input.binding,
        { app: input.app, entrypoint: input.entrypoint },
        false,
        "request",
      );

      if (valid.isErr()) return valid;

      const [pending] = await transaction
        .select()
        .from(connectionRequests)
        .where(
          and(
            eq(connectionRequests.appId, input.appId),
            eq(connectionRequests.binding, input.binding),
            eq(connectionRequests.status, "pending"),
          ),
        );

      if (
        pending &&
        (pending.serviceId !== input.app ||
          pending.entrypoint !== input.entrypoint ||
          pending.requesterId !== principal.id)
      )
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "A connection request already exists for this binding",
        });
      const id = pending?.id ?? crypto.randomUUID();

      if (!pending)
        await transaction.insert(connectionRequests).values({
          id,
          organizationId: principal.application.organizationId,
          appId: input.appId,
          serviceId: input.app,
          binding: input.binding,
          entrypoint: input.entrypoint,
          requesterId: principal.id,
        });
      const [request] = await readRequests(transaction, principal, id);

      if (!request) throw new Error("Created connection request not found");

      return Result.ok(request);
    }),
  reject: (principal: Principal, requestId: string) =>
    transact(database, async (transaction) => {
      organizationAdministrator(principal);
      await lockOrganizationRuntime(transaction, principal.application.organizationId);

      const [request] = await transaction
        .select()
        .from(connectionRequests)
        .where(
          and(
            eq(connectionRequests.id, requestId),
            eq(connectionRequests.organizationId, principal.application.organizationId),
          ),
        )
        .for("update");

      if (!request)
        throw new InvalidOperation({ code: "NOT_FOUND", message: "Connection request not found" });

      if (request.status !== "pending")
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "This connection request is no longer pending",
        });
      await transaction
        .update(connectionRequests)
        .set({ status: "rejected" })
        .where(eq(connectionRequests.id, requestId));
      const [updated] = await readRequests(transaction, principal, requestId);

      if (!updated) throw new Error("Rejected connection request not found");

      return Result.ok(updated);
    }),
  approve: async (principal: Principal, requestId: string) => {
    const prepared = await transact(database, async (transaction) => {
      organizationAdministrator(principal);
      const [request] = await readRequests(transaction, principal, requestId);

      if (!request)
        throw new InvalidOperation({ code: "NOT_FOUND", message: "Connection request not found" });

      if (request.status === "rejected")
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "This connection request was rejected",
        });

      return Result.ok(request);
    });

    if (prepared.isErr() || prepared.value.status === "approved") return prepared;
    const request = prepared.value;
    const grant = { app: request.serviceId, entrypoint: request.entrypoint };

    const applied = execution
      ? await execution.connections.bind(
          principal,
          request.appId,
          request.binding,
          grant,
          request.id,
        )
      : await transact(database, (transaction) =>
          applyCapabilityChange(
            transaction,
            principal,
            request.appId,
            request.binding,
            grant,
            true,
            request.id,
          ),
        );

    if (applied.isErr()) return applied;

    return transact(database, async (transaction) => {
      const [updated] = await readRequests(transaction, principal, requestId);

      if (!updated) throw new Error("Approved connection request not found");

      return Result.ok(updated);
    });
  },
});
