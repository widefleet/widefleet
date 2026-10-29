import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  organizationIdentifier,
  workflowEventType,
  workflowInstanceId,
  workflowName,
  workflowRequest,
  workflowRestartOptions,
  workflowRestartFrom,
} from "@platform/contracts";
import { z } from "zod";
import { readApp } from "./catalog.ts";
import { readExecutionAvailability, readOrganizationAvailability } from "./availability.ts";
import type { ParentEnvironment } from "./types.ts";
import {
  workflowOptions,
  nativeStepName,
  stepId,
  type CreateOptions,
  type WorkflowValue,
  type Start,
} from "./workflow-protocol.ts";

const scopeSchema = z.strictObject({
  appId: z.uuid(),
  hostname: z.string().regex(/^[a-z0-9.-]+$/),
  workflow: workflowName,
});

export type WorkflowScope = z.infer<typeof scopeSchema>;

export type InstanceInput =
  | { type: string; payload: WorkflowValue }
  | z.input<typeof workflowRestartOptions>
  | { rollback?: boolean };

type RecordEntry = {
  creation: Omit<CreateOptions, "id" | "params">;
  id: string;
  nativeId: string;
  createdAt: string;
  start: Start;
  started: boolean;
  suspension?: { reason: "organization"; requestedAt: string };
};

type PauseReconciliation = {
  id: string;
  organizationId: string;
  since: string;
  cursor?: string;
  pending: boolean;
  complete: boolean;
};

const key = (workflow: string, id: string) => `instance/${workflow}/${id}`;

const missing = (cause: unknown) =>
  cause instanceof Error && /not.found|does not exist/i.test(cause.message);

class WorkflowAdmissionError extends Error {}

export const workflowCatalog = (environment: ParentEnvironment, appId: string) =>
  environment.WIDEFLEET_WORKFLOW_CATALOG.get(
    environment.WIDEFLEET_WORKFLOW_CATALOG.idFromName(appId),
  );

export class WorkflowCatalog extends DurableObject<ParentEnvironment> {
  protected createNative(
    options: WorkflowInstanceCreateOptions<Start> & { id: string; params: Start },
  ) {
    return this.env.WIDEFLEET_WORKFLOWS.create(options);
  }
  private async requireExecution(scope: Pick<WorkflowScope, "appId" | "hostname">) {
    try {
      if ((await readExecutionAvailability(this.env, scope)).blocked)
        throw new Error("Organization execution is suspended");
    } catch (cause) {
      throw new WorkflowAdmissionError(
        cause instanceof Error ? cause.message : "Workflow admission failed",
        { cause },
      );
    }
  }
  async reconcile(organizationId: string) {
    organizationIdentifier.parse(organizationId);
    const availability = await readOrganizationAvailability(this.env, organizationId);

    if (availability === null) throw new Error("Organization availability could not be read");

    return this.ctx.blockConcurrencyWhile(async () => {
      if (!availability.blocked) {
        await this.invalidateReconciliation();

        return;
      }

      if (await this.ctx.storage.get<boolean>("deleted")) return;
      const previous = await this.ctx.storage.get<PauseReconciliation>("pauseReconciliation");

      const reconciliation =
        previous?.organizationId === organizationId
          ? previous
          : {
              id: crypto.randomUUID(),
              organizationId,
              since: new Date().toISOString(),
              pending: false,
              complete: false,
            };

      // This is progress for pausing instances, never a second admission gate.
      // Repeated quota evaluations do not rescan a completed catalog.
      if (reconciliation.complete) return;
      await this.ctx.storage.put("pauseReconciliation", reconciliation);

      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + 1);
      await this.ctx.storage.sync();
    });
  }
  private async invalidateReconciliation() {
    await this.ctx.storage.delete("pauseReconciliation");
    await this.ctx.storage.deleteAlarm();
  }
  private async currentReconciliation(expected: PauseReconciliation) {
    const current = await this.ctx.storage.get<PauseReconciliation>("pauseReconciliation");

    return current?.id === expected.id && current.cursor === expected.cursor && !current.complete;
  }
  private async pauseRecord(
    name: string,
    record: RecordEntry,
    reconciliation: PauseReconciliation,
  ) {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        (async () => {
          const instance = await this.env.WIDEFLEET_WORKFLOWS.get(record.nativeId);
          const { status } = await this.status(instance);

          if (["paused", "complete", "errored", "terminated"].includes(status)) return false;

          if (expired || status === "unknown" || status === "waitingForPause") return true;

          const ready = await this.ctx.blockConcurrencyWhile(async () => {
            if (expired || !(await this.currentReconciliation(reconciliation))) return false;
            const current = await this.ctx.storage.get<RecordEntry>(name);

            if (!current || current.nativeId !== record.nativeId) return false;
            current.suspension = { reason: "organization", requestedAt: reconciliation.since };
            await this.ctx.storage.put(name, current);

            return true;
          });

          if (ready && !expired) await instance.pause();

          return true;
        })(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            resolve(true);
          }, 5_000);
        }),
      ]);
    } catch (cause) {
      if (missing(cause)) return false;
      console.error("Workflow suspension could not be applied", { instanceId: record.nativeId });

      return true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  override async alarm() {
    const reconciliation = await this.ctx.storage.get<PauseReconciliation>("pauseReconciliation");

    if (!reconciliation || reconciliation.complete) return;

    const availability = await readOrganizationAvailability(
      this.env,
      reconciliation.organizationId,
    );

    if (availability === null) {
      // Keep the saved work and retry even after the platform's alarm retries expire.
      await this.ctx.storage.setAlarm(Date.now() + 10_000);

      return;
    }

    if (!availability.blocked) {
      await this.ctx.blockConcurrencyWhile(async () => {
        if (await this.currentReconciliation(reconciliation))
          await this.invalidateReconciliation();
      });

      return;
    }

    const options: DurableObjectListOptions = { prefix: "instance/", limit: 10 };

    if (reconciliation.cursor) options.startAfter = reconciliation.cursor;
    const records = await this.ctx.storage.list<RecordEntry>(options);

    // Provider calls run outside the storage lock. One slow instance cannot
    // block admission or prevent other instances/pages from being processed.
    const pending = await Promise.all(
      [...records].map(([name, record]) => this.pauseRecord(name, record, reconciliation)),
    );

    await this.ctx.blockConcurrencyWhile(async () => {
      if (!(await this.currentReconciliation(reconciliation))) return;
      reconciliation.pending ||= pending.some(Boolean);
      const cursor = [...records.keys()].at(-1);

      if (records.size === 10 && cursor) {
        reconciliation.cursor = cursor;
        await this.ctx.storage.setAlarm(Date.now() + 1);
      } else {
        delete reconciliation.cursor;
        reconciliation.complete = !reconciliation.pending;

        if (reconciliation.pending) await this.ctx.storage.setAlarm(Date.now() + 10_000);
        else await this.ctx.storage.deleteAlarm();
        reconciliation.pending = false;
      }

      await this.ctx.storage.put("pauseReconciliation", reconciliation);
    });
  }
  protected async restartTarget(from: z.infer<typeof workflowRestartFrom>) {
    // celld's adapter prepares each operation in a separate native checkpoint.
    return workflowRestartFrom.parse({ name: await nativeStepName(stepId(from)), type: "do" });
  }
  protected status(instance: WorkflowInstance) {
    return instance.status();
  }
  private async active(scope: WorkflowScope) {
    scopeSchema.parse(scope);

    if (await this.ctx.storage.get<boolean>("deleted")) throw new Error("App is being deleted");
    const app = await readApp(this.env, `hosts/${scope.hostname}.json`);

    if (!app || app.appId !== scope.appId) throw new Error("App is not published");

    return app;
  }
  private async confirm(record: RecordEntry) {
    if (!record.started) {
      record.started = true;
      delete record.start.params;
      await this.ctx.storage.put(key(record.start.workflow, record.id), record);
    }
  }
  private async native(record: RecordEntry) {
    const instance = await this.env.WIDEFLEET_WORKFLOWS.get(record.nativeId);

    // Creation can succeed before the catalog confirms it. Finding that
    // instance repairs the catalog without starting any new execution.
    await this.confirm(record);

    return instance;
  }
  private async readStatus(record: RecordEntry) {
    try {
      return {
        ...(await this.status(await this.native(record))),
        suspension: record.suspension ?? null,
      };
    } catch (error) {
      if (record.started || !missing(error)) throw error;

      return {
        status: "unknown" as const,
        suspension: record.suspension ?? null,
        error: {
          name: "WorkflowInstanceUnavailable",
          message: "Workflow creation was not confirmed and its native instance is missing",
        },
      };
    }
  }
  private async start(record: RecordEntry) {
    await this.requireExecution(record.start);
    await this.invalidateReconciliation();
    await this.ctx.storage.put(key(record.start.workflow, record.id), record);
    let instance;

    try {
      const options: WorkflowInstanceCreateOptions<Start> & { id: string; params: Start } = {
        id: record.nativeId,
        params: record.start,
      };

      if (record.creation.locationHint) options.locationHint = record.creation.locationHint;

      if (record.creation.retention) {
        options.retention = {};

        if (record.creation.retention.successRetention !== undefined)
          options.retention.successRetention = record.creation.retention.successRetention;

        if (record.creation.retention.errorRetention !== undefined)
          options.retention.errorRetention = record.creation.retention.errorRetention;
      }

      instance = await this.createNative(options);
    } catch (error) {
      // A failed response does not prove creation failed. Recover an existing
      // instance, but never issue another create from a lookup.
      try {
        return await this.native(record);
      } catch {
        throw error;
      }
    }

    await this.confirm(record);

    return instance;
  }
  private async createInstance(scope: WorkflowScope, options: z.infer<typeof workflowOptions>) {
    const app = await this.active(scope);

    if (
      !app.metadata.bindings.some(
        (binding) => binding.type === "workflow" && binding.workflow_name === scope.workflow,
      )
    )
      throw new Error("Workflow is not declared by the current deployment");
    const id = options.id ?? crypto.randomUUID();
    const name = key(scope.workflow, id);
    const previous = await this.ctx.storage.get<RecordEntry>(name);

    if (previous) throw new Error("Workflow instance already exists");

    const record = {
      creation: { retention: options.retention, locationHint: options.locationHint },
      id,
      nativeId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      started: false,
      start: { ...scope, id, version: app.version, params: options.params },
    };

    await this.start(record);

    return { id };
  }
  create(scope: WorkflowScope, options: CreateOptions = {}) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.createInstance(scopeSchema.parse(scope), workflowOptions.parse(options)),
    );
  }
  createBatch(scope: WorkflowScope, batch: CreateOptions[]) {
    return this.ctx.blockConcurrencyWhile(async () => {
      scopeSchema.parse(scope);
      const options = z.array(workflowOptions).min(1).max(100).parse(batch);
      const created = [];

      for (const option of options) {
        if (option.id && (await this.ctx.storage.get(key(scope.workflow, option.id)))) continue;
        created.push(await this.createInstance(scope, option));
      }

      return created;
    });
  }
  deleteBatch(scope: WorkflowScope, ids: string[]) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const parsed = z.array(workflowInstanceId).min(1).max(100).parse(ids);

      const outcomes = new Map<
        string,
        { id: string } | { id: string; code: number; message: string }
      >();

      for (const id of new Set(parsed)) {
        try {
          await this.operate(scope, id, "delete");
          outcomes.set(id, { id });
        } catch (cause) {
          outcomes.set(id, {
            id,
            code: missing(cause) ? 10400 : 10001,
            message: missing(cause)
              ? "workflows.api.error.instance.not_found"
              : "workflows.api.error.internal_server",
          });
        }
      }

      const deleted: { id: string }[] = [];
      const errors: { id: string; code: number; message: string }[] = [];

      for (const id of parsed) {
        const result = outcomes.get(id);

        if (!result) throw new Error("Missing deletion result");

        if ("code" in result) errors.push(result);
        else deleted.push(result);
      }

      return { deleted, errors };
    });
  }
  get(scope: WorkflowScope, id: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.active(scope);

      const record = await this.ctx.storage.get<RecordEntry>(
        key(scope.workflow, workflowInstanceId.parse(id)),
      );

      if (!record) throw new Error("Workflow instance not found");

      // Catalog handles remain usable for inspecting and deleting failed
      // creations or expired instances; obtaining a handle never starts work.
      return { id };
    });
  }
  private async operate(scope: WorkflowScope, id: string, action: string, input?: InstanceInput) {
    await this.active(scope);
    const name = key(scope.workflow, workflowInstanceId.parse(id));
    const record = await this.ctx.storage.get<RecordEntry>(name);

    if (!record) throw new Error("Workflow instance not found");

    if (action === "delete") {
      try {
        await (await this.env.WIDEFLEET_WORKFLOWS.get(record.nativeId)).delete();
      } catch (error) {
        if (!missing(error)) throw error;
      }

      await this.ctx.storage.delete(name);

      return null;
    }

    if (action === "status") return this.readStatus(record);

    if (action === "resume" || action === "restart" || action === "sendEvent")
      await this.requireExecution(scope);

    if (action === "resume" || action === "restart") await this.invalidateReconciliation();
    const instance = await this.native(record);

    switch (action) {
      case "sendEvent":
        await instance.sendEvent(
          z.strictObject({ type: workflowEventType, payload: z.unknown() }).parse(input),
        );
        break;
      case "pause":
        await instance.pause();
        break;
      case "resume":
        await instance.resume();
        break;
      case "restart": {
        const { from } = workflowRestartOptions.parse(input === undefined ? {} : input);

        if (from) {
          try {
            await instance.restart({
              from: await this.restartTarget(from),
            });
          } catch (cause) {
            if (cause instanceof Error && cause.message.includes("restart() could not find"))
              throw new Error(
                `Workflow history has no ${from.type} step ${JSON.stringify(from.name)} occurrence ${from.count}`,
              );
            throw cause;
          }
        } else await instance.restart();
        break;
      }

      case "terminate":
        if (input !== undefined)
          z.strictObject({ rollback: z.literal(false).optional() }).parse(input);
        await instance.terminate();
        break;
      default:
        throw new Error("Unsupported Workflow operation");
    }

    if (action === "resume" || action === "restart") {
      delete record.suspension;
      await this.ctx.storage.put(name, record);
    }

    return null;
  }
  instance(scope: WorkflowScope, id: string, action: string, input?: InstanceInput) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.operate(scopeSchema.parse(scope), id, action, input),
    );
  }
  manage(scope: WorkflowScope, requestId: string, input: z.infer<typeof workflowRequest>) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.active(scope);
      const request = workflowRequest.parse(input);

      if (request.workflow !== scope.workflow) throw new Error("Workflow scope mismatch");

      if (request.action === "list") {
        const prefix = `instance/${scope.workflow}/`;

        if (request.cursor && !request.cursor.startsWith(prefix)) throw new Error("Invalid cursor");
        const options: DurableObjectListOptions = { prefix, limit: 101 };

        if (request.cursor) options.startAfter = request.cursor;
        const records = await this.ctx.storage.list<RecordEntry>(options);
        const page = [...records].slice(0, 100);

        const instances = await Promise.all(
          page.map(async ([, record]) => {
            const item = {
              id: record.id,
              version: record.start.version,
              createdAt: record.createdAt,
              suspension: record.suspension ?? null,
            };

            try {
              const state = await this.readStatus(record);

              if (state.status === "unknown" && state.error)
                return { ...item, status: state.status, error: state.error };

              return { ...item, status: state.status };
            } catch (error) {
              if (!missing(error)) throw error;

              return { ...item, status: "expired" };
            }
          }),
        );

        return { instances, cursor: records.size > 100 ? (page.at(-1)?.[0] ?? null) : null };
      }

      if (request.action === "status") return this.operate(scope, request.id, "status");
      const operationKey = `operation/${z.uuid().parse(requestId)}`;

      const previous = await this.ctx.storage.get<{
        request: string;
        complete: boolean;
        result?: WorkflowValue;
      }>(operationKey);

      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(request)),
      );

      const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");

      if (previous) {
        if (previous.request !== fingerprint)
          throw new Error("Operation ID already used for another request");

        if (!previous.complete)
          throw new Error(
            "Previous operation outcome is unknown; inspect the instance before submitting another operation",
          );

        return previous.result;
      }

      // Record intent first. A retried agent job must never send an event or
      // restart twice after an ambiguous connection failure.
      await this.ctx.storage.put(operationKey, { request: fingerprint, complete: false });
      let result;

      try {
        result =
          request.action === "create"
            ? await this.createInstance(
                scope,
                workflowOptions.parse({ id: request.id, params: request.params }),
              )
            : await this.operate(
                scope,
                request.id,
                request.action,
                request.action === "sendEvent"
                  ? request.event
                  : request.action === "restart"
                    ? { from: request.from }
                    : undefined,
              );
      } catch (error) {
        // Admission errors occur before native execution. Keep ambiguous native
        // failures reserved, but let a rejected request retry after unblocking.
        if (error instanceof WorkflowAdmissionError) {
          await this.ctx.storage.delete(operationKey);
          // Throwing from blockConcurrencyWhile resets the object. Persist the
          // deletion first so that reset cannot leave the request ID reserved.
          await this.ctx.storage.sync();
        }

        throw error;
      }

      await this.ctx.storage.put(operationKey, { request: fingerprint, complete: true, result });

      return result;
    });
  }
  purge() {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put("deleted", true);
      await this.invalidateReconciliation();
      const records = await this.ctx.storage.list<RecordEntry>({ prefix: "instance/", limit: 100 });

      for (const [name, record] of records) {
        try {
          await (await this.env.WIDEFLEET_WORKFLOWS.get(record.nativeId)).delete();
        } catch (error) {
          if (!missing(error)) throw error;
        }

        await this.ctx.storage.delete(name);
      }

      const operations = await this.ctx.storage.list({ prefix: "operation/", limit: 100 });

      if (operations.size) await this.ctx.storage.delete([...operations.keys()]);

      return { done: records.size < 100 && operations.size < 100 };
    });
  }
}

export class WorkflowBinding extends WorkerEntrypoint<ParentEnvironment, WorkflowScope> {
  create(options?: CreateOptions) {
    return workflowCatalog(this.env, this.ctx.props.appId).create(this.ctx.props, options);
  }
  createBatch(batch: CreateOptions[]) {
    return workflowCatalog(this.env, this.ctx.props.appId).createBatch(this.ctx.props, batch);
  }
  deleteBatch(ids: string[]) {
    return workflowCatalog(this.env, this.ctx.props.appId).deleteBatch(this.ctx.props, ids);
  }
  get(id: string) {
    return workflowCatalog(this.env, this.ctx.props.appId).get(this.ctx.props, id);
  }
  instance(id: string, action: string, input?: InstanceInput) {
    return workflowCatalog(this.env, this.ctx.props.appId).instance(
      this.ctx.props,
      id,
      action,
      input,
    );
  }
}
