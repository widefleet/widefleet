import { WorkerEntrypoint } from "cloudflare:workers";
import * as z from "zod";
import type { BindingProperties, Json, NativeBindings, ParentEnvironment } from "./types.ts";

export const nativeBinding = <K extends keyof NativeBindings>(
  environment: ParentEnvironment,
  name: string,
  kind: K,
) => {
  if (!environment[name]) throw new Error(`Missing native ${kind} binding`);

  // SAFETY: Only the trusted loader selects a native name in immutable loopback props.
  return environment[name] as NativeBindings[K];
};

const statement = z.object({
  sql: z.string(),
  parameters: z.array(
    z.union([z.string(), z.number(), z.null(), z.array(z.number().int().min(0).max(255))]),
  ),
});

export type StatementInput = z.infer<typeof statement>;

const databaseRequest = z.discriminatedUnion("method", [
  z.object({ method: z.literal("all"), statement }),
  z.object({ method: z.literal("first"), statement, column: z.string().optional() }),
  z.object({ method: z.literal("raw"), statement, columnNames: z.boolean() }),
  z.object({ method: z.literal("batch"), statements: z.array(statement) }),
  z.object({ method: z.literal("exec"), sql: z.string() }),
]);

export type DatabaseRequest = z.infer<typeof databaseRequest>;

export class Database extends WorkerEntrypoint<ParentEnvironment, BindingProperties> {
  async query(input: DatabaseRequest, bookmark?: string) {
    const request = databaseRequest.parse(input);
    const database = nativeBinding(this.env, this.ctx.props.name, "d1");
    const session = database.withSession(bookmark);
    const prepare = (input: StatementInput) => session.prepare(input.sql).bind(...input.parameters);

    const execute = async () => {
      switch (request.method) {
        case "all":
          return prepare(request.statement).all<Record<string, Json>>();
        case "first":
          return request.column === undefined
            ? prepare(request.statement).first<Record<string, Json>>()
            : prepare(request.statement).first<Json>(request.column);
        case "raw":
          return request.columnNames
            ? prepare(request.statement).raw<Json[]>({ columnNames: true })
            : prepare(request.statement).raw<Json[]>();
        case "batch":
          return session.batch<Record<string, Json>>(request.statements.map(prepare));
        case "exec":
          return database.exec(request.sql);
      }
    };

    const result = await execute();

    return { result, bookmark: session.getBookmark() };
  }
}

const keyValueOperation = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("get"), key: z.string(), cacheTtl: z.number().optional() }),
  z.strictObject({
    method: z.literal("put"),
    key: z.string(),
    options: z
      .strictObject({
        expiration: z.number().optional(),
        expirationTtl: z.number().optional(),
        metadata: z.json().optional(),
      })
      .optional(),
  }),
]);

export type KeyValueOperation = z.infer<typeof keyValueOperation>;

export class KeyValue extends WorkerEntrypoint<ParentEnvironment, BindingProperties> {
  override async fetch(request: Request) {
    try {
      const input = keyValueOperation.parse(
        JSON.parse(decodeURIComponent(request.headers.get("x-widefleet-kv") ?? "null")),
      );

      const namespace = nativeBinding(this.env, this.ctx.props.name, "kv_namespace");

      if (input.method === "put") {
        const options: KVNamespacePutOptions = {};

        if (input.options?.expiration !== undefined) options.expiration = input.options.expiration;

        if (input.options?.expirationTtl !== undefined)
          options.expirationTtl = input.options.expirationTtl;

        if (input.options?.metadata !== undefined) options.metadata = input.options.metadata;
        // Native KV applies its value-size bound while consuming the body.
        // A complete buffer in the calling app would bypass that early check.
        await namespace.put(input.key, request.body ?? new Uint8Array(), options);

        return new Response(null, { status: 204 });
      }

      const options: KVNamespaceGetOptions<"stream"> = { type: "stream" };

      if (input.cacheTtl !== undefined) options.cacheTtl = input.cacheTtl;
      const result = await namespace.getWithMetadata<Json>(input.key, options);

      return new Response(result.value, {
        status: result.value === null ? 404 : 200,
        headers: {
          "x-widefleet-kv": encodeURIComponent(
            JSON.stringify({ metadata: result.metadata, cacheStatus: result.cacheStatus }),
          ),
        },
      });
    } catch (cause) {
      return Response.json({ error: String(cause) }, { status: 400 });
    }
  }
  async getMany(keys: string[], cacheTtl?: number) {
    const options: KVNamespaceGetOptions<"text"> = { type: "text" };

    if (cacheTtl !== undefined) options.cacheTtl = cacheTtl;

    return [
      ...(await nativeBinding(this.env, this.ctx.props.name, "kv_namespace").getWithMetadata<Json>(
        keys,
        options,
      )),
    ];
  }
  list(options?: KVNamespaceListOptions) {
    return nativeBinding(this.env, this.ctx.props.name, "kv_namespace").list<Json>(options);
  }
  delete(key: string) {
    return nativeBinding(this.env, this.ctx.props.name, "kv_namespace").delete(key);
  }
}

export class Producer extends WorkerEntrypoint<ParentEnvironment, BindingProperties> {
  send(body: Json | ArrayBuffer, options?: QueueSendOptions) {
    return nativeBinding(this.env, this.ctx.props.name, "queue").send(body, options);
  }
  sendBatch(
    messages: Iterable<MessageSendRequest<Json | ArrayBuffer>>,
    options?: QueueSendBatchOptions,
  ) {
    return nativeBinding(this.env, this.ctx.props.name, "queue").sendBatch(messages, options);
  }
}
