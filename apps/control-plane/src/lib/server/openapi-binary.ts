import { toOpenAPISchema, type OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import {
  deployment,
  workerMetadata,
  connectorUploadMetadata,
  connectorStatus,
  appSlug,
} from "@platform/contracts";

const converter = new ZodToJsonSchemaConverter();

export const binarySchemas = {
  ConnectorName: toOpenAPISchema(converter.convert(appSlug, { strategy: "input" })[1]),
  WorkerUploadMetadata: toOpenAPISchema(
    converter.convert(workerMetadata, { strategy: "input" })[1],
  ),
  QueuedDeployment: toOpenAPISchema(converter.convert(deployment, { strategy: "output" })[1]),
  ConnectorUploadMetadata: toOpenAPISchema(
    converter.convert(connectorUploadMetadata, { strategy: "input" })[1],
  ),
  ConnectorDeploymentStatus: toOpenAPISchema(
    converter.convert(connectorStatus, { strategy: "output" })[1],
  ),
};

const workerRequestBody = (metadata: string) => ({
  required: true,
  content: {
    "multipart/form-data": {
      schema: {
        type: "object" as const,
        required: ["metadata"],
        properties: { metadata: { $ref: `#/components/schemas/${metadata}` } },
        additionalProperties: { type: "string" as const, format: "binary" },
      },
      encoding: { metadata: { contentType: "application/json" } },
    },
  },
});

const workerUploadDescription =
  "Use one metadata field containing JSON and one file part per module, named after that module. Source maps are private artifacts referenced by metadata.debug.source_maps, never public assets or runtime modules. Up to 32 runtime modules and 500 source maps, 20 MiB per file, 64 KiB of UTF-8 metadata and 100 MiB per request.";

export const binaryPaths = {
  "/connectors/{name}": {
    put: {
      operationId: "connectorDeploy",
      summary: "Upload connector modules and queue activation",
      description: `${workerUploadDescription} Supported MIME types: application/javascript+module, application/source-map+json. Requires platform:write scope and administrator access. The connector name comes from the path. Repeating an unchanged pending or successful deployment returns its status; repeating a failed deployment retries it.`,
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          schema: { $ref: "#/components/schemas/ConnectorName" },
        },
      ],
      requestBody: workerRequestBody("ConnectorUploadMetadata"),
      responses: {
        "200": {
          description: "Connector deployment accepted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ConnectorDeploymentStatus" },
            },
          },
        },
      },
    },
  },
  "/apps/{appId}/assets/{sessionId}/{hash}": {
    put: {
      operationId: "uploadAsset",
      summary: "Upload a missing asset with its Wrangler-compatible BLAKE3 hash",
      parameters: [
        { name: "appId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        {
          name: "sessionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "hash",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[a-f0-9]{32}$" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/octet-stream": {
            schema: {
              type: "string",
              format: "binary",
              description: "At most 25 MiB. The bytes must match the manifest's hash and size.",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Asset uploaded or already present",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["uploaded"],
                properties: { uploaded: { type: "boolean" } },
              },
            },
          },
        },
      },
    },
  },
  "/apps/{appId}/worker": {
    put: {
      operationId: "publishWorker",
      summary: "Publish immutable worker modules after uploading all missing assets",
      description: `${workerUploadDescription} Supported MIME types: application/javascript+module, application/wasm, text/plain, application/octet-stream, application/source-map+json. Repeating the same Idempotency-Key and upload session returns the original deployment; changed content conflicts.`,
      parameters: [
        { name: "appId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: workerRequestBody("WorkerUploadMetadata"),
      responses: {
        "200": {
          description: "Deployment queued",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/QueuedDeployment" },
            },
          },
        },
      },
    },
  },
  "/agent/jobs/{jobId}/assets/{hash}": {
    get: {
      operationId: "downloadAsset",
      summary: "Download an asset belonging to the job's artifact with an active agent lease",
      parameters: [
        { name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        {
          name: "hash",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[a-f0-9]{32}$" },
        },
        {
          name: "leaseToken",
          in: "query",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Asset bytes",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
      },
    },
  },
  "/agent/jobs/{jobId}/modules/{sha256}": {
    get: {
      operationId: "downloadModule",
      summary: "Download a module belonging to the job's artifact with an active agent lease",
      parameters: [
        { name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        {
          name: "sha256",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        {
          name: "leaseToken",
          in: "query",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Module bytes",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
      },
    },
  },
  "/agent/jobs/{jobId}/migrations/{sha256}": {
    get: {
      operationId: "downloadMigrationArtifact",
      summary: "Download the migration artifact belonging to the job with an active agent lease",
      parameters: [
        { name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        {
          name: "sha256",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        {
          name: "leaseToken",
          in: "query",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Immutable JSON migration request; verify its size and SHA-256 before use",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
      },
    },
  },
} satisfies NonNullable<Awaited<ReturnType<OpenAPIGenerator["generate"]>>["paths"]>;
