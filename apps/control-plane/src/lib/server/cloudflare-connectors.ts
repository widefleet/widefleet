import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { administrator, connectorStatus, prepareConnector } from "./connector-changes.ts";
import {
  connectorReference,
  loadConnector,
  validateConnectorSecret,
  validateConnectorPackage,
} from "./connector-package.ts";
import { acceptCloudflareWorkflow } from "./cloudflare-admission.ts";
import { connectorCommand, deploymentWorkflowCommand } from "./cloudflare-connector-command.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import type { Database } from "./database.ts";
import type { HostedExecution } from "./deployment-execution.ts";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import { defaultFleet, lockFleet } from "./fleets.ts";
import { cloudflareOperations, connectors } from "./schema.ts";
import { encryptSecret } from "./secret-encryption.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact } from "./transactions.ts";

export const registerCloudflareConnector = (
  database: Database,
  storage: ArtifactStorage,
  command: z.infer<typeof connectorCommand>,
) =>
  transact(database, async (transaction) => {
    administrator(command.actor);
    const fleet = await lockFleet(transaction, command.fleetId);

    if (fleet.executor !== "cloudflare")
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "This installation does not use Cloudflare execution",
      });

    const [accepted] = await transaction
      .select()
      .from(cloudflareOperations)
      .where(eq(cloudflareOperations.id, command.id));

    if (accepted) {
      if (!isDeepStrictEqual(accepted.command, command))
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "The operation ID already refers to another command",
        });

      return Result.ok(accepted);
    }

    let reference: z.infer<typeof connectorReference>;

    if (command.change.kind === "deploy") {
      const release = await loadConnector(storage, command.change);

      if (release.name !== command.change.name)
        throw new Error("Connector package identity mismatch");
      reference = (await prepareConnector(transaction, storage, fleet, release)).reference;
    } else {
      const [existing] = await transaction
        .select()
        .from(connectors)
        .where(and(eq(connectors.fleetId, fleet.id), eq(connectors.name, command.change.name)));

      if (!existing)
        throw new InvalidOperation({ code: "NOT_FOUND", message: "Connector not found" });
      const previous = connectorReference.parse(existing.package);
      const secrets = new Map(Object.entries(previous.secrets));

      if (command.change.ciphertext === null) secrets.delete(command.change.secret);
      else secrets.set(command.change.secret, command.change.ciphertext);
      reference = {
        ...previous,
        secrets: Object.fromEntries(secrets),
        secretRevision: previous.secretRevision + 1,
      };
      validateConnectorPackage(
        await loadConnector(storage, reference),
        Object.keys(reference.secrets),
      );
    }

    const [operation] = await transaction
      .insert(cloudflareOperations)
      .values({
        id: command.id,
        fleetId: fleet.id,
        command,
        targets: [],
        result: reference,
        createdAt: new Date(command.createdAt),
      })
      .returning();

    if (!operation) throw new Error("Connector operation history returned no row");
    await transaction
      .insert(connectors)
      .values({ fleetId: fleet.id, name: reference.name, package: reference, jobId: command.id })
      .onConflictDoUpdate({
        target: [connectors.fleetId, connectors.name],
        set: { package: reference, jobId: command.id },
      });

    return Result.ok(operation);
  });

export const cloudflareConnectorStatus = async (
  bindings: CloudflareBindings,
  current: z.infer<typeof contract.connectorStatus>,
) => {
  if (current.state !== "queued" && current.state !== "running") return current;

  try {
    if (!bindings.DEPLOYMENTS) throw new Error("The deployment Workflow binding is missing");
    const instance = await bindings.DEPLOYMENTS.get(current.jobId);
    const state = await instance.status();

    return {
      ...current,
      state:
        state.status === "errored" || state.status === "terminated"
          ? ("failed" as const)
          : state.status === "running"
            ? ("running" as const)
            : current.state,
      message:
        state.status === "errored" || state.status === "terminated"
          ? "Cloudflare stopped the connector deployment before completion"
          : current.message,
    };
  } catch (cause) {
    throw new StorageUnavailable({ message: "Cloudflare connector status is unavailable", cause });
  }
};

export const createCloudflareConnectors = (
  bindings: CloudflareBindings,
  database: Database,
  storage: ArtifactStorage,
): Pick<HostedExecution["connectors"], "deploy" | "setSecret" | "status"> => {
  const admit = (command: z.infer<typeof connectorCommand>) =>
    Result.tryPromise({
      try: async () => {
        const workflow = bindings.DEPLOYMENTS;

        if (!workflow) throw new Error("The deployment Workflow binding is missing");

        const accepted = await acceptCloudflareWorkflow(
          bindings.ARTIFACTS,
          workflow,
          connectorCommand.parse(command),
          deploymentWorkflowCommand,
        );

        const parsed = connectorCommand.parse(accepted);
        const operation = (await registerCloudflareConnector(database, storage, parsed)).unwrap();

        return (
          await transact(database, async (transaction) => {
            const [record] = await transaction
              .select()
              .from(connectors)
              .where(
                and(
                  eq(connectors.fleetId, command.fleetId),
                  eq(connectors.name, command.change.name),
                ),
              );

            if (!record) throw new Error("The accepted connector deployment has no history");

            // Another request may already have replaced the desired connector. Return
            // the command this caller submitted, not that newer request's job identity.
            return Result.ok(
              await connectorStatus(transaction, {
                ...record,
                package: operation.result,
                jobId: command.id,
              }),
            );
          })
        ).unwrap();
      },
      catch: (cause) =>
        cause instanceof InvalidOperation ||
        cause instanceof DatabaseUnavailable ||
        cause instanceof StorageUnavailable
          ? cause
          : new StorageUnavailable({
              message: "Cloudflare could not accept the connector deployment",
              cause,
            }),
    });

  return {
    status: (current) => cloudflareConnectorStatus(bindings, current),
    deploy: async (principal, release) => {
      const prepared = await transact(database, async (transaction) => {
        administrator(principal);
        const fleet = await lockFleet(transaction, (await defaultFleet(transaction)).id);

        const { reference, existing } = await prepareConnector(
          transaction,
          storage,
          fleet,
          release,
        );

        const current = existing
          ? await cloudflareConnectorStatus(bindings, await connectorStatus(transaction, existing))
          : null;

        return Result.ok({
          fleetId: fleet.id,
          checksum: reference.checksum,
          current:
            current?.checksum === reference.checksum && current.state !== "failed" ? current : null,
        });
      });

      if (prepared.isErr()) return prepared;

      if (prepared.value.current) return Result.ok(prepared.value.current);

      return admit({
        kind: "connector",
        id: crypto.randomUUID(),
        fleetId: prepared.value.fleetId,
        createdAt: new Date().toISOString(),
        actor: principal,
        change: { kind: "deploy", name: release.name, checksum: prepared.value.checksum },
      });
    },
    setSecret: async (principal, name, secret, value) => {
      const prepared = await transact(database, async (transaction) => {
        administrator(principal);
        contract.connectorSecretName.parse(secret);

        if (value !== null) validateConnectorSecret(value);

        const fleet = await lockFleet(transaction, (await defaultFleet(transaction)).id);

        const [record] = await transaction
          .select()
          .from(connectors)
          .where(and(eq(connectors.fleetId, fleet.id), eq(connectors.name, name)));

        if (!record)
          throw new InvalidOperation({ code: "NOT_FOUND", message: "Connector not found" });
        const reference = connectorReference.parse(record.package);
        const names = new Set(Object.keys(reference.secrets));

        if (value === null) names.delete(secret);
        else names.add(secret);
        validateConnectorPackage(await loadConnector(storage, reference), [...names]);

        return Result.ok({
          fleetId: fleet.id,
          ciphertext:
            value === null ? null : await encryptSecret(bindings.PLATFORM_ENCRYPTION_KEY, value),
        });
      });

      if (prepared.isErr()) return prepared;

      return admit({
        kind: "connector",
        id: crypto.randomUUID(),
        fleetId: prepared.value.fleetId,
        createdAt: new Date().toISOString(),
        actor: principal,
        change: { kind: "secret", name, secret, ciphertext: prepared.value.ciphertext },
      });
    },
  };
};
