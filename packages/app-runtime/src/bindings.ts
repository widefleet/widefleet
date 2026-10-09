import { workflowOptions, type CreateOptions } from "./workflow-protocol.ts";
import { workflowInstanceId } from "@platform/contracts";
import type { WorkflowBinding, InstanceInput } from "./workflow-catalog.ts";
import { installFetch } from "./fetch.ts";
import { env } from "cloudflare:workers";
import { config } from "./config.ts";
import * as z from "zod";
import type {
  Database,
  DatabaseRequest,
  KeyValue,
  KeyValueOperation,
  Producer,
  StatementInput,
} from "./storage.ts";
import { objectListing, objectMetadata, type ObjectOperation } from "./objects.ts";

const binding = <T extends Database | KeyValue | Producer | WorkflowBinding>(name: string) => {
  // SAFETY: These service bindings are created by the trusted loader, from the same manifest.
  return (env as Record<string, T>)[name];
};

const requireBinding = <T extends Database | KeyValue | Producer | WorkflowBinding>(
  name: string,
) => {
  const service = binding<T>(name);

  if (!service) throw new Error("Binding is not initialized");

  return service;
};

const json = z.json();

type RawOptions = { columnNames?: boolean };

class Statement {
  constructor(
    readonly database: DatabaseFacade,
    readonly input: StatementInput,
  ) {}
  bind(...parameters: (string | number | null | ArrayBuffer | ArrayBufferView | number[])[]) {
    return new Statement(this.database, {
      sql: this.input.sql,
      parameters: parameters.map((value) =>
        value instanceof ArrayBuffer
          ? [...new Uint8Array(value)]
          : ArrayBuffer.isView(value)
            ? [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]
            : value,
      ),
    });
  }
  all() {
    return this.database.query({ method: "all", statement: this.input });
  }
  run() {
    return this.all();
  }
  first(column?: string) {
    return this.database.query({ method: "first", statement: this.input, column });
  }
  raw(options?: RawOptions) {
    return this.database.query({
      method: "raw",
      statement: this.input,
      columnNames: options?.columnNames ?? false,
    });
  }
}

class DatabaseFacade {
  private bookmark: string | null;
  constructor(
    readonly name: string,
    bookmark?: string,
  ) {
    this.bookmark =
      bookmark && !["first-primary", "first-unconstrained"].includes(bookmark) ? bookmark : null;
  }
  async query(input: DatabaseRequest) {
    const response = await requireBinding<Database>(this.name).query(
      input,
      this.bookmark ?? undefined,
    );

    this.bookmark = response.bookmark;

    return response.result;
  }
  prepare(sql: string) {
    return new Statement(this, { sql, parameters: [] });
  }
  batch(statements: Statement[]) {
    if (statements.some((statement) => statement.database.name !== this.name))
      throw new Error("Statements must belong to this database");

    return this.query({
      method: "batch",
      statements: statements.map((statement) => statement.input),
    });
  }
  exec(sql: string) {
    return this.query({ method: "exec", sql });
  }
  withSession(bookmark?: string) {
    return new DatabaseFacade(this.name, bookmark);
  }
  getBookmark() {
    return this.bookmark;
  }
  dump() {
    throw new Error("D1 dump() is not implemented in celld");
  }
}

type KvReadOptions =
  | "text"
  | "json"
  | "arrayBuffer"
  | "stream"
  | { type?: "text" | "json" | "arrayBuffer" | "stream"; cacheTtl?: number };

const kvOptions = z
  .union([
    z.enum(["text", "json", "arrayBuffer", "stream"]),
    z.object({
      type: z.enum(["text", "json", "arrayBuffer", "stream"]).optional(),
      cacheTtl: z.number().optional(),
    }),
  ])
  .transform((value) => {
    if (value === "text" || value === "json" || value === "arrayBuffer" || value === "stream")
      return { type: value, cacheTtl: undefined };

    return { type: value.type ?? "text", cacheTtl: value.cacheTtl };
  });

class KeyValueFacade {
  constructor(readonly name: string) {}
  async request(operation: KeyValueOperation, body?: BodyInit) {
    const response = await requireBinding<KeyValue>(this.name).fetch(
      new Request("https://binding.invalid/", {
        method: "POST",
        headers: { "x-widefleet-kv": encodeURIComponent(JSON.stringify(operation)) },
        body: body ?? null,
      }),
    );

    if (!response.ok && response.status !== 404) {
      const error = z.object({ error: z.string() }).parse(await response.json());
      throw new Error(error.error);
    }

    return response;
  }
  async getWithMetadata(key: string | string[], options: KvReadOptions = "text") {
    const parsed = kvOptions.parse(options);

    if (Array.isArray(key)) {
      if (parsed.type !== "text" && parsed.type !== "json")
        throw new Error("Bulk KV reads support text and JSON values");

      const results = await requireBinding<KeyValue>(this.name).getMany(key, parsed.cacheTtl);

      return new Map(
        results.map(([name, result]) => [
          name,
          {
            ...result,
            value:
              parsed.type === "json" && result.value !== null
                ? json.parse(JSON.parse(result.value))
                : result.value,
          },
        ]),
      );
    }

    const response = await this.request({ method: "get", key, cacheTtl: parsed.cacheTtl });

    const result = z
      .object({ metadata: json.nullable(), cacheStatus: z.string().nullable() })
      .parse(JSON.parse(decodeURIComponent(response.headers.get("x-widefleet-kv") ?? "null")));

    if (response.status === 404) return { ...result, value: null };

    switch (parsed.type) {
      case "arrayBuffer":
        return { ...result, value: await response.arrayBuffer() };
      case "stream":
        return { ...result, value: response.body };
      case "json":
        return { ...result, value: json.parse(await response.json()) };
      case "text":
        return { ...result, value: await response.text() };
    }
  }
  async get(key: string | string[], options?: KvReadOptions) {
    const result = await this.getWithMetadata(key, options);

    return result instanceof Map
      ? new Map([...result].map(([name, entry]) => [name, entry.value]))
      : result.value;
  }
  async put(key: string, value: BodyInit, options?: KVNamespacePutOptions) {
    const response = await this.request(
      {
        method: "put",
        key,
        options: options && {
          expiration: options.expiration,
          expirationTtl: options.expirationTtl,
          metadata: options.metadata === undefined ? undefined : json.parse(options.metadata),
        },
      },
      value,
    );

    await response.body?.cancel();
  }
  list(options?: KVNamespaceListOptions) {
    return requireBinding<KeyValue>(this.name).list(options);
  }
  delete(key: string) {
    return requireBinding<KeyValue>(this.name).delete(key);
  }
}

const restoreObject = (metadata: z.infer<typeof objectMetadata>) => ({
  ...metadata,
  checksums: {
    ...Object.fromEntries(
      Object.entries(metadata.checksums).map(([name, hex]) => [
        name,
        Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16)).buffer,
      ]),
    ),
    toJSON() {
      return metadata.checksums;
    },
  },
  writeHttpMetadata(headers: Headers) {
    const values = metadata.httpMetadata;

    if (!values) return;

    for (const [name, value] of [
      ["content-type", values.contentType],
      ["content-language", values.contentLanguage],
      ["content-disposition", values.contentDisposition],
      ["content-encoding", values.contentEncoding],
      ["cache-control", values.cacheControl],
      ["expires", values.cacheExpiry?.toUTCString()],
    ])
      if (name && value !== undefined) headers.set(name, value);
  },
});

const normalizeHeaders = (value: Headers | R2HTTPMetadata | undefined) =>
  value instanceof Headers
    ? {
        contentType: value.get("content-type") ?? undefined,
        contentLanguage: value.get("content-language") ?? undefined,
        contentDisposition: value.get("content-disposition") ?? undefined,
        contentEncoding: value.get("content-encoding") ?? undefined,
        cacheControl: value.get("cache-control") ?? undefined,
        cacheExpiry: value.has("expires") ? new Date(value.get("expires") ?? "") : undefined,
      }
    : value;

const normalizeCondition = (value: Headers | R2Conditional | undefined) =>
  value instanceof Headers
    ? {
        etagMatches: value.get("if-match") ?? undefined,
        etagDoesNotMatch: value.get("if-none-match") ?? undefined,
        uploadedBefore: value.has("if-unmodified-since")
          ? new Date(value.get("if-unmodified-since") ?? "")
          : undefined,
        uploadedAfter: value.has("if-modified-since")
          ? new Date(value.get("if-modified-since") ?? "")
          : undefined,
        secondsGranularity: true,
      }
    : value;

const hex = (value: string | ArrayBuffer | ArrayBufferView | undefined) => {
  if (value === undefined) return undefined;

  if (value instanceof ArrayBuffer) return hex(new Uint8Array(value));

  if (ArrayBuffer.isView(value))
    return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

  return value;
};

const normalizePut = (options?: R2PutOptions) => {
  if (options?.ssecKey) throw new Error("R2 customer-key encryption is unavailable in celld");

  return {
    ...options,
    httpMetadata: normalizeHeaders(options?.httpMetadata),
    onlyIf: normalizeCondition(options?.onlyIf),
    md5: hex(options?.md5),
    sha1: hex(options?.sha1),
    sha256: hex(options?.sha256),
    sha384: hex(options?.sha384),
    sha512: hex(options?.sha512),
  };
};

const normalizeRange = (range: R2Range | Headers | undefined) => {
  if (!(range instanceof Headers)) return range;
  const header = range.get("range");

  if (!header) return undefined;
  const parsed = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

  if (!parsed) throw new Error("Invalid R2 range header");
  const first = parsed[1];
  const last = parsed[2];

  if (first === "") return { suffix: Number(last) };

  if (last === "") return { offset: Number(first) };

  return { offset: Number(first), length: Number(last) - Number(first) + 1 };
};

const uploadedPart = z.object({ partNumber: z.number(), etag: z.string() });

const upload = z.object({ key: z.string(), uploadId: z.string() });

class ObjectsFacade {
  constructor(readonly name: string) {}
  async request(operation: ObjectOperation, body?: BodyInit | null) {
    // SAFETY: The trusted loader supplies one R2 service Fetcher per declared bucket.
    const service = (env as Record<string, Fetcher>)[this.name];

    if (!service) throw new Error("Binding is not initialized");

    const response = await service.fetch("https://binding.invalid/", {
      method: "POST",
      headers: { "x-widefleet-operation": encodeURIComponent(JSON.stringify(operation)) },
      body: body ?? null,
    });

    if (!response.ok && response.status !== 404) {
      const error = z.object({ error: z.string() }).parse(await response.json());
      throw new Error(error.error);
    }

    return response;
  }
  async head(key: string) {
    const result = objectMetadata
      .nullable()
      .parse(await (await this.request({ method: "head", key })).json());

    return result === null ? null : restoreObject(result);
  }
  async get(key: string, options?: R2GetOptions) {
    if (options?.ssecKey) throw new Error("R2 customer-key encryption is unavailable in celld");

    const response = await this.request({
      method: "get",
      key,
      options: {
        ...options,
        range: normalizeRange(options?.range),
        onlyIf: normalizeCondition(options?.onlyIf),
      },
    });

    if (response.status === 404) return null;

    const metadata = restoreObject(
      objectMetadata.parse(
        JSON.parse(decodeURIComponent(response.headers.get("x-widefleet-object") ?? "null")),
      ),
    );

    if (response.headers.get("x-widefleet-body") !== "true") return metadata;

    return {
      ...metadata,
      body: response.body,
      get bodyUsed() {
        return response.bodyUsed;
      },
      arrayBuffer: () => response.arrayBuffer(),
      bytes: () => response.bytes(),
      text: () => response.text(),
      json: async () => json.parse(await response.json()),
      blob: () => response.blob(),
    };
  }
  async put(key: string, body: BodyInit | null, options?: R2PutOptions) {
    const result = objectMetadata
      .nullable()
      .parse(
        await (
          await this.request({ method: "put", key, options: normalizePut(options) }, body)
        ).json(),
      );

    return result === null ? null : restoreObject(result);
  }
  async delete(keys: string | string[]) {
    await this.request({ method: "delete", keys });
  }
  async list(options?: R2ListOptions) {
    const page = objectListing.parse(
      await (await this.request({ method: "list", options })).json(),
    );

    return { ...page, objects: page.objects.map(restoreObject) };
  }
  async createMultipartUpload(key: string, options?: R2MultipartOptions) {
    const result = upload.parse(
      await (
        await this.request({ method: "createMultipartUpload", key, options: normalizePut(options) })
      ).json(),
    );

    return this.resumeMultipartUpload(result.key, result.uploadId);
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, body: BodyInit) =>
        uploadedPart.parse(
          await (
            await this.request({ method: "uploadPart", key, uploadId, partNumber }, body)
          ).json(),
        ),
      complete: async (parts: R2UploadedPart[]) =>
        restoreObject(
          objectMetadata.parse(
            await (await this.request({ method: "complete", key, uploadId, parts })).json(),
          ),
        ),
      abort: async () => {
        await this.request({ method: "abort", key, uploadId });
      },
    };
  }
}

class WorkflowFacade {
  constructor(readonly name: string) {}
  private handle(id: string) {
    const service = () => requireBinding<WorkflowBinding>(this.name);

    return {
      id,
      status: () => service().instance(id, "status"),
      sendEvent: (event: InstanceInput) => service().instance(id, "sendEvent", event),
      pause: () => service().instance(id, "pause"),
      resume: () => service().instance(id, "resume"),
      restart: (options?: InstanceInput) => service().instance(id, "restart", options),
      terminate: (options?: InstanceInput) => service().instance(id, "terminate", options),
      delete: () => service().instance(id, "delete"),
    };
  }
  async create(options?: CreateOptions) {
    return this.handle((await requireBinding<WorkflowBinding>(this.name).create(options)).id);
  }
  async createBatch(batch: CreateOptions[]) {
    const options = z.array(workflowOptions).min(1).max(100).parse(batch);
    const serializable = [];

    for (const option of options) {
      try {
        structuredClone(option.params);
        serializable.push(option);
      } catch {
        /* Native createBatch skips parameters that cannot be cloned. */
      }
    }

    if (serializable.length === 0) return [];

    return (await requireBinding<WorkflowBinding>(this.name).createBatch(serializable)).map(
      ({ id }) => this.handle(id),
    );
  }
  deleteBatch(ids: string[]) {
    return requireBinding<WorkflowBinding>(this.name).deleteBatch(
      z.array(workflowInstanceId).min(1).max(100).parse(ids),
    );
  }
  async get(id: string) {
    return this.handle((await requireBinding<WorkflowBinding>(this.name).get(id)).id);
  }
}

// Install facades before evaluating the app. Native service handles themselves
// are resolved lazily: celld initializes env after module evaluation.
for (const descriptor of config.metadata.bindings) {
  let facade;

  switch (descriptor.type) {
    case "workflow":
      facade = new WorkflowFacade(`WIDEFLEET_WORKFLOW_${descriptor.name}`);
      break;
    case "d1":
      facade = new DatabaseFacade(`WIDEFLEET_D1_${descriptor.name}`);
      break;
    case "r2_bucket":
      facade = new ObjectsFacade(`WIDEFLEET_R2_${descriptor.name}`);
      break;
    case "kv_namespace":
      facade = new KeyValueFacade(`WIDEFLEET_KV_${descriptor.name}`);
      break;
    case "queue":
      facade = {
        send: (body: Parameters<Producer["send"]>[0], options?: QueueSendOptions) =>
          requireBinding<Producer>(`WIDEFLEET_QUEUE_${descriptor.name}`).send(body, options),
        sendBatch: (
          messages: Parameters<Producer["sendBatch"]>[0],
          options?: QueueSendBatchOptions,
        ) =>
          requireBinding<Producer>(`WIDEFLEET_QUEUE_${descriptor.name}`).sendBatch(
            [...messages],
            options,
          ),
      };
      break;
    case "plain_text":
      continue;
  }

  Object.defineProperty(env, descriptor.name, {
    value: facade,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

installFetch();
