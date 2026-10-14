import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { managedApp } from "./apps.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import type { Database } from "./database.ts";
import type { Principal } from "./identity.ts";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { acceptCloudflareWorkflow } from "./cloudflare-admission.ts";
import { cloudflareAppOperation } from "./cloudflare-app-operation-command.ts";
import { cloudflareOperations, fleets } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact } from "./transactions.ts";

export const registerCloudflareAppOperation = (
  database: Database,
  command: z.infer<typeof cloudflareAppOperation>,
) =>
  transact(database, async (transaction) => {
    const access = await managedApp(transaction, command.actor, command.appId);

    if (access.isErr()) return access;

    const [fleet] = await transaction
      .select()
      .from(fleets)
      .where(eq(fleets.id, access.value.fleetId));

    if (fleet?.executor !== "cloudflare")
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "This installation does not use Cloudflare execution",
      });

    const [created] = await transaction
      .insert(cloudflareOperations)
      .values({
        id: command.id,
        appId: command.appId,
        command,
        targets: [],
        result: { value: null },
        createdAt: new Date(command.createdAt),
      })
      .onConflictDoNothing()
      .returning();

    const existing =
      created ??
      (
        await transaction
          .select()
          .from(cloudflareOperations)
          .where(eq(cloudflareOperations.id, command.id))
      )[0];

    const stored = existing ? cloudflareAppOperation.safeParse(existing.command) : null;

    if (!existing || !stored?.success || JSON.stringify(stored.data) !== JSON.stringify(command))
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "The request ID already refers to another operation",
      });

    return Result.ok(existing);
  });

export const createCloudflareAppOperations = (
  bindings: CloudflareBindings,
  database: Database,
  storage: ArtifactStorage,
) => {
  const read = (
    principal: Pick<Principal, "id" | "admin">,
    appId: string,
    id: string,
    kind: "migrations" | "workflows",
  ): Promise<
    Result<
      z.infer<typeof contract.workflowOperation>,
      DatabaseUnavailable | InvalidOperation | StorageUnavailable
    >
  > =>
    transact(database, async (transaction) => {
      const access = await managedApp(transaction, principal, appId);

      if (access.isErr()) return access;

      const [record] = await transaction
        .select()
        .from(cloudflareOperations)
        .where(and(eq(cloudflareOperations.id, id), eq(cloudflareOperations.appId, appId)));

      const parsed = record ? cloudflareAppOperation.safeParse(record.command) : null;

      if (!record || !parsed?.success || parsed.data.kind !== kind)
        throw new InvalidOperation({ code: "NOT_FOUND", message: "Operation not found" });

      if (record.finishedAt)
        return Result.ok(
          contract.workflowOperation.parse({
            id,
            state: record.error ? "failed" : "succeeded",
            message: record.error,
            result: z.object({ value: z.json() }).parse(record.result).value,
          }),
        );
      const workflow = bindings.APP_OPERATIONS;

      if (!workflow)
        throw new StorageUnavailable({
          message: "App operation Workflow binding is missing",
          cause: null,
        });
      const native = await (await workflow.get(id)).status();

      const failed =
        native.status === "errored" ||
        native.status === "terminated" ||
        (native.status === "complete" && record.error !== null);

      return Result.ok(
        contract.workflowOperation.parse({
          id,
          state: failed
            ? "failed"
            : native.status === "complete" && record.finishedAt
              ? "succeeded"
              : native.status === "queued"
                ? "queued"
                : "running",
          message: failed
            ? (record.error ?? "Cloudflare stopped the operation before completion")
            : null,
          result:
            native.status === "complete" && !failed
              ? z.object({ value: z.json() }).parse(record.result).value
              : null,
        }),
      );
    });

  const admit = (input: z.infer<typeof cloudflareAppOperation>) =>
    Result.tryPromise({
      try: async () => {
        const command = cloudflareAppOperation.parse(input);

        const [previous] = await database
          .select()
          .from(cloudflareOperations)
          .where(eq(cloudflareOperations.id, command.id));

        if (previous?.finishedAt) {
          // Completed results outlive native Workflow retention. Retrying an API
          // request must not create a fresh management operation after expiry.
          const parsed = cloudflareAppOperation.safeParse(previous.command);

          if (!parsed.success)
            throw new InvalidOperation({
              code: "CONFLICT",
              message: "The request ID already refers to another operation",
            });
          const { createdAt: _previousTime, ...stored } = parsed.data;

          const { createdAt: _requestedTime, ...requested } = command;

          if (JSON.stringify(stored) !== JSON.stringify(requested))
            throw new InvalidOperation({
              code: "CONFLICT",
              message: "The request ID already refers to another operation",
            });

          return;
        }

        const workflow = bindings.APP_OPERATIONS;

        if (!workflow)
          throw new StorageUnavailable({
            message: "App operation Workflow binding is missing",
            cause: null,
          });

        const accepted = await acceptCloudflareWorkflow(
          bindings.ARTIFACTS,
          workflow,
          command,
          cloudflareAppOperation,
        );

        (await registerCloudflareAppOperation(database, accepted)).unwrap();
      },
      catch: (error) =>
        error instanceof InvalidOperation
          ? error
          : new StorageUnavailable({
              message: "Cloudflare could not accept the operation",
              cause: error,
            }),
    });

  return {
    async migrate(
      principal: Principal,
      appId: string,
      id: string,
      input: z.infer<typeof contract.migrationRequest>,
    ) {
      const bytes = Buffer.from(JSON.stringify(contract.migrationRequest.parse(input)));

      const migration = contract.migrationArtifact.parse({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      });

      const saved = await storage.put(
        `apps/${appId}/migrations/${migration.sha256}`,
        bytes,
        "application/json",
      );

      if (saved.isErr()) return saved;

      const accepted = await admit({
        id,
        appId,
        kind: "migrations",
        migration,
        actor: { id: principal.id, admin: principal.admin },
        createdAt: new Date().toISOString(),
      });

      if (accepted.isErr()) return accepted;

      return (await read(principal, appId, id, "migrations")).map(({ result, ...value }) =>
        contract.migrationOperation.parse({ ...value, entries: result }),
      );
    },
    async workflow(
      principal: Principal,
      appId: string,
      id: string,
      request: z.infer<typeof contract.workflowRequest>,
    ) {
      const accepted = await admit({
        id,
        appId,
        kind: "workflows",
        request: contract.workflowRequest.parse(request),
        actor: { id: principal.id, admin: principal.admin },
        createdAt: new Date().toISOString(),
      });

      if (accepted.isErr()) return accepted;

      return (await read(principal, appId, id, "workflows")).map((value) =>
        contract.workflowOperation.parse(value),
      );
    },
    readMigration: async (principal: Principal, appId: string, id: string) =>
      (await read(principal, appId, id, "migrations")).map(({ result, ...value }) =>
        contract.migrationOperation.parse({ ...value, entries: result }),
      ),
    readWorkflow: async (principal: Principal, appId: string, id: string) =>
      (await read(principal, appId, id, "workflows")).map((value) =>
        contract.workflowOperation.parse(value),
      ),
  };
};
