import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  workflowEventType,
  workflowInstanceId,
  workflowName,
  workflowRequest,
  workflowRestartOptions,
} from "@platform/contracts";
import { z } from "zod";
import { readApp } from "./catalog.ts";
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
};

const key = (workflow: string, id: string) => `instance/${workflow}/${id}`;

const missing = (cause: unknown) =>
  cause instanceof Error && /not.found|does not exist/i.test(cause.message);

export const workflowCatalog = (environment: ParentEnvironment, appId: string) =>
  environment.WIDEFLEET_WORKFLOW_CATALOG.get(
    environment.WIDEFLEET_WORKFLOW_CATALOG.idFromName(appId),
  );

export class WorkflowCatalog extends DurableObject<ParentEnvironment> {
  private async active(scope: WorkflowScope) {
    scopeSchema.parse(scope);

    if (await this.ctx.storage.get<boolean>("deleted")) throw new Error("App is being deleted");
    const app = await readApp(this.env, `hosts/${scope.hostname}.json`);

    if (!app || app.appId !== scope.appId) throw new Error("App is not published");

    return app;
  }
  private async native(record: RecordEntry) {
    if (!record.started) {
      try {
        const options: WorkflowInstanceCreateOptions<Start> = {
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

        await this.env.WIDEFLEET_WORKFLOWS.create(options);
      } catch (error) {
        // A crash can leave a committed native create with an uncommitted catalogue update.
        try {
          await this.env.WIDEFLEET_WORKFLOWS.get(record.nativeId);
        } catch {
          throw error;
        }
      }

      record.started = true;
      delete record.start.params;
      await this.ctx.storage.put(key(record.start.workflow, record.id), record);
    }

    return this.env.WIDEFLEET_WORKFLOWS.get(record.nativeId);
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

    if (previous) {
      if (!previous.started) await this.native(previous);
      throw new Error("Workflow instance already exists");
    }

    const record = {
      creation: { retention: options.retention, locationHint: options.locationHint },
      id,
      nativeId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      started: false,
      start: { ...scope, id, version: app.version, params: options.params },
    };

    await this.ctx.storage.put(name, record);
    await this.native(record);

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

      // Retain a handle to expired catalog entries so callers can delete them.
      if (!record.started) await this.native(record);

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

    const instance = await this.native(record);

    switch (action) {
      case "status":
        return instance.status();
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
              from: { name: await nativeStepName(stepId(from)), type: from.type },
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
            let status;

            try {
              status = (await (await this.native(record)).status()).status;
            } catch (error) {
              if (!missing(error)) throw error;
              status = "expired";
            }

            return {
              id: record.id,
              version: record.start.version,
              createdAt: record.createdAt,
              status,
            };
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

      const result =
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

      await this.ctx.storage.put(operationKey, { request: fingerprint, complete: true, result });

      return result;
    });
  }
  purge() {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put("deleted", true);
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
