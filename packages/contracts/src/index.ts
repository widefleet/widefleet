export { appEventConfiguration } from "./app-events.ts";

export { workerHostname } from "./hostnames.ts";

export * from "./source.ts";

export { shortenTypeNames } from "./service-type-names.ts";

export { serviceBindingTypes } from "./service-binding-types.ts";

import { z } from "zod";
import { appSourceSummary, gitBranch, sourceRevision } from "./source.ts";

import {
  appRpcMethod,
  serviceDescriptionMaxMethods,
  serviceDescriptionMaxTypes,
  serviceDocumentation,
  serviceMethodSelection,
  serviceMethodSummary,
  serviceTypeName,
} from "./service-documentation.ts";

export * from "./mcp.ts";

export * from "./user-connections.ts";

import { organizationIdentifier } from "./organizations.ts";
import { appAccessSnapshot } from "./app-access.ts";
import { networkDeclaration, networkPolicy, networkSnapshot } from "./network.ts";
import { migrationEntry } from "./migrations.ts";
import { workflowName, workflowRequest } from "./workflows.ts";
import { templatePath } from "./templates.ts";

export * from "./migrations.ts";

export * from "./workflows.ts";

export * from "./network.ts";

export * from "./app-access.ts";

export * from "./directory.ts";

export * from "./organizations.ts";

export * from "./members.ts";

export * from "./reporting.ts";

export * from "./templates.ts";

export * from "./service-input.ts";

export const protocolVersion = 1;

export const identifier = z.uuid();

export const appSlug = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/);

export const appNameLength = 120;

/** The name people see. An app's slug and address do not follow it. */
export const appDisplayName = z.string().trim().min(1).max(appNameLength);

/** One sentence that tells people what an app is for. An empty text removes it. */
export const appDescriptionLength = 200;

export const appDescription = z.string().trim().max(appDescriptionLength);

export const createAppInput = z.strictObject({
  slug: appSlug.refine(
    (value) => !["auth", "mcp"].includes(value),
    "The auth and mcp hostnames are reserved for platform services",
  ),
  displayName: appDisplayName,
  parentId: identifier.nullable().default(null),
  previewBranch: gitBranch.optional(),
  previewName: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    .optional(),
});

export const app = z.strictObject({
  source: appSourceSummary.optional(),
  id: identifier,
  slug: appSlug,
  displayName: z.string(),
  description: z.string().nullable().default(null),
  catalogListed: z.boolean(),
  web: z.boolean().default(true),
  parentId: identifier.nullable(),
  organizationId: organizationIdentifier,
  hostname: z.string(),
  url: z.url(),
  createdAt: z.iso.datetime(),
  state: z.enum(["created", "active", "deleting"]),
  activeDeploymentId: identifier.nullable(),
});

export const deployment = z.strictObject({
  id: identifier,
  appId: identifier,
  artifactId: identifier,
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  message: z.string().nullable(),
});

export const templateInstallInput = templatePath.extend({
  /** The new app's name; the template ID by default. */
  name: appSlug.optional(),
});

export const templateInstall = z.strictObject({
  app,
  deployment,
  /** Build notes, such as dependencies whose types could not be installed. */
  warnings: z.array(z.string()),
  /** Origins the template declares that the app is not allowed to reach yet. */
  requestedNetwork: networkPolicy.optional(),
});

export const deploymentEvent = z.strictObject({
  id: z.number().int(),
  deploymentId: identifier,
  createdAt: z.iso.datetime(),
  level: z.enum(["info", "error"]),
  message: z.string(),
});

export const appPath = z.strictObject({ appId: identifier });

export const sourceDeployTargetInput = z.union([appPath, z.strictObject({ slug: appSlug })]);

export const catalogEntry = app.pick({
  id: true,
  displayName: true,
  description: true,
  hostname: true,
  url: true,
  activeDeploymentId: true,
});

export const catalogListing = z.strictObject({ listed: z.boolean() });

export const catalogListingInput = appPath.extend(catalogListing.shape);

export const appDescriptionChange = z.strictObject({ description: appDescription });

export const appDescriptionInput = appPath.extend(appDescriptionChange.shape);

export const appNameChange = z.strictObject({ displayName: appDisplayName });

export const appNameInput = appPath.extend(appNameChange.shape);

export const deploymentPath = z.strictObject({ deploymentId: identifier });

export const assetHash = z.string().regex(/^[a-f0-9]{32}$/);

export const checksum = z.string().regex(/^[a-f0-9]{64}$/);

export const assetPath = z
  .string()
  .min(2)
  .max(1024)
  .refine((value) => {
    for (const character of value) {
      if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return false;
    }

    return (
      value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .slice(1)
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
  }, "Expected an absolute asset path without traversal or control characters");

export const assetEntry = z.strictObject({
  hash: assetHash,
  size: z
    .number()
    .int()
    .min(0)
    .max(25 * 1024 * 1024),
});

export const assetManifest = z.record(assetPath, assetEntry).superRefine((manifest, context) => {
  const entries = Object.entries(manifest);

  if (entries.length > 10_000) {
    context.addIssue({ code: "custom", message: "At most 10,000 assets are allowed" });
  }

  const sizes = new Map<string, number>();

  for (const [, entry] of entries) {
    const existing = sizes.get(entry.hash);

    if (existing !== undefined && existing !== entry.size) {
      context.addIssue({ code: "custom", message: "An asset hash has conflicting sizes" });
    }

    sizes.set(entry.hash, entry.size);
  }

  if ([...sizes.values()].reduce((total, size) => total + size, 0) > 250 * 1024 * 1024) {
    context.addIssue({ code: "custom", message: "Assets exceed the 250 MiB deployment limit" });
  }
});

export const createUploadInput = z.strictObject({ manifest: assetManifest });

export const uploadSession = z.strictObject({
  id: identifier,
  url: z.url(),
  expiresAt: z.iso.datetime(),
  missing: z.array(assetHash),
});

export const bindingName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);

export const workerBinding = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("workflow"),
    name: bindingName,
    workflow_name: workflowName,
    class_name: bindingName,
  }),
  z.strictObject({
    type: z.literal("plain_text"),
    name: bindingName,
    text: z.string().max(16_384),
  }),
  z.strictObject({
    type: z.literal("d1"),
    name: bindingName,
    database_name: z.string().min(1).max(128),
    database_id: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    type: z.literal("r2_bucket"),
    name: bindingName,
    bucket_name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/),
  }),
  z.strictObject({
    type: z.literal("kv_namespace"),
    name: bindingName,
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  }),
  z.strictObject({
    type: z.literal("queue"),
    name: bindingName,
    queue: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  }),
]);

export const queueConsumer = z.strictObject({
  queue: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  max_batch_size: z.number().int().min(1).max(100).optional(),
  max_batch_timeout: z.number().int().min(0).max(60).optional(),
  max_retries: z.number().int().min(0).max(100).optional(),
  retry_delay: z.number().int().min(0).max(86400).optional(),
  dead_letter_queue: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
});

export const moduleName = z
  .string()
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/)
  .refine((name) => !name.startsWith("__widefleet_"), "Platform module names are reserved");

export const debugMetadata = z.strictObject({
  build_id: z.string().min(1).max(128),
  source_maps: z
    .record(z.union([moduleName, assetPath]), moduleName)
    .refine((maps) => Object.keys(maps).length <= 500, "Too many source maps"),
});

export const workerConfiguration = z.strictObject({
  main_module: moduleName,
  compatibility_date: z.iso.date(),
  compatibility_flags: z
    .array(z.enum(["nodejs_als", "nodejs_compat"]))
    .max(2)
    .refine((flags) => new Set(flags).size === flags.length, "Compatibility flags must be unique")
    .default([]),
  bindings: z.array(workerBinding).max(32).default([]),
  debug: debugMetadata.optional(),
});

export {
  appRpcMethod,
  listServiceMethods,
  selectServiceMethods,
  serviceDescriptionBudget,
  serviceDescriptionMaxMethods,
  serviceDescriptionMaxTypes,
  serviceMethodSelection,
  serviceTypeName,
  serviceMethodSummary,
  summaryLine,
  serviceDocumentation,
  serviceDocumentationMaxBytes,
  serviceDocumentationPart,
  serviceDocumentationMaxSignatures,
} from "./service-documentation.ts";

export const workerMetadata = workerConfiguration
  .extend({
    source: sourceRevision.optional(),
    web: z.boolean().optional(),
    // Origins the app declares in widefleet.jsonc; see networkDeclaration.
    network: networkDeclaration.optional(),
    entrypoints: z
      .array(bindingName)
      .max(32)
      .refine(
        (names) =>
          new Set(names).size === names.length &&
          names.every(
            (name) =>
              !name.startsWith("WIDEFLEET_") && !["Events", "WorkflowRunner"].includes(name),
          ),
        "Service entrypoints must be unique and cannot use platform names",
      )
      .optional(),
    crons: z.array(z.string().min(1)).default([]),
    queue_consumers: z.array(queueConsumer).default([]),
    assets: z.strictObject({ upload_session: identifier, binding: bindingName.default("ASSETS") }),
  })
  .superRefine((metadata, context) => {
    const workflows = metadata.bindings
      .filter((binding) => binding.type === "workflow")
      .map((binding) => binding.workflow_name);

    if (new Set(workflows).size !== workflows.length)
      context.addIssue({ code: "custom", message: "Workflow names must be unique within an app" });
    const names = [metadata.assets.binding, ...metadata.bindings.map((binding) => binding.name)];

    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "Binding names must be unique" });
    }

    if (names.some((name) => name.startsWith("WIDEFLEET_"))) {
      context.addIssue({
        code: "custom",
        message: "WIDEFLEET_ bindings are reserved for the platform",
      });
    }
  });

// Existing runtimes validate metadata strictly. Retain source provenance in the
// control plane.
export function executionWorkerMetadata(value: z.infer<typeof workerMetadata>) {
  const metadata = { ...value };
  delete metadata.source;
  // Declared origins are a control-plane request; runtimes enforce the granted
  // policy and reject metadata fields they do not know.
  delete metadata.network;

  return metadata;
}

export const storedModule = z.strictObject({
  name: moduleName,
  type: z.enum(["esm", "wasm", "text", "data", "sourcemap"]),
  sha256: checksum,
  size: z
    .number()
    .int()
    .min(0)
    .max(20 * 1024 * 1024),
});

export const artifact = z.strictObject({
  id: identifier,
  appId: identifier,
  metadata: workerMetadata,
  manifest: assetManifest,
  modules: z.array(storedModule).min(1).max(532),
});

// The release is independent of the agent executable. Protocol changes, rather
// than JavaScript changes, determine whether an installer update is necessary.
export const runtimeRelease = z.strictObject({
  protocol: z.literal(3),
  auth: z.literal(1),
  // Build metadata names one of several builds of a product version, for example
  // each hosted deployment. Published releases carry the plain product version.
  version: z
    .string()
    .max(64)
    .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/),
  celld: z.enum(["0.6.2", "0.6.3-widefleet.1"]),
  workflows: z.literal(1).optional(),
  cloudflare: z.literal(1).optional(),
  // The runtime accepts service-index refreshes from publishers.
  search: z.literal(1).optional(),
  main: z.literal("loader.js"),
  modules: z
    .array(
      z.strictObject({
        name: moduleName,
        source: z.string(),
        sha256: checksum,
      }),
    )
    .min(1),
});

export { appCaller } from "./app-caller.ts";

const appSecretMaxBytes = 5_000;

export const appEnvironmentMaxBindings = 128;

export const appSecretName = bindingName.refine(
  (name) => !name.startsWith("WIDEFLEET_") && name !== "__proto__",
  "Reserved app secret name",
);

const appSecretSizeMessage = "Secret value must contain at most 5 KB (5000 UTF-8 bytes)";

export const appSecretValue = z
  .string()
  .min(1)
  .max(appSecretMaxBytes, appSecretSizeMessage)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= appSecretMaxBytes,
    appSecretSizeMessage,
  );

export const appSecretPreparation = z.strictObject({
  appId: identifier,
  revision: z.number().int().nonnegative(),
  values: z.record(appSecretName, appSecretValue),
});

export const appSecretStatus = z.strictObject({
  names: z.array(appSecretName),
  revision: z.number().int().nonnegative(),
  appliedRevision: z.number().int().nonnegative().nullable(),
  deployment: deployment.nullable(),
});

export const serviceAccessMode = z.enum(["approval_required", "organization"]);

export const serviceAccessChange = z.strictObject({ accessMode: serviceAccessMode });

export const serviceCatalogEntry = z.strictObject({
  appId: identifier,
  slug: appSlug,
  displayName: z.string(),
  entrypoints: z.array(bindingName),
  accessMode: serviceAccessMode.default("approval_required"),
});

/** An app API's complete documentation, as its reference page presents it. */
export const serviceReference = serviceCatalogEntry.extend({
  deploymentId: identifier,
  documentation: serviceDocumentation.nullable(),
});

/**
 * An app API's methods, and the documentation of the methods a caller selects
 * with their types. Large APIs stay readable without loading the whole document.
 */
export const serviceDescription = serviceCatalogEntry.extend({
  deploymentId: identifier,
  documented: z.boolean(),
  methods: z.array(serviceMethodSummary),
  documentation: serviceMethodSelection.nullable(),
});

export const servicePath = z.strictObject({ service: z.string().min(1).max(128) });

export const serviceDescriptionQuery = servicePath.extend({
  entrypoint: bindingName.default("default"),
  // Repeated as `methods[]=` and `types[]=`; type names can contain commas.
  methods: z.array(appRpcMethod).max(serviceDescriptionMaxMethods).default([]),
  types: z.array(serviceTypeName).max(serviceDescriptionMaxTypes).default([]),
});

export const serviceBindingTypesQuery = servicePath.extend({
  entrypoint: bindingName.default("default"),
  // The binding's name in the caller's environment, which names the generated interface.
  binding: bindingName,
});

/** TypeScript declarations for a caller's binding, generated from an app API's documentation. */
export const serviceBindingTypesResult = serviceCatalogEntry.extend({
  deploymentId: identifier,
  entrypoint: bindingName,
  binding: bindingName,
  declarations: z.string(),
});

export const capabilityGrant = z.strictObject({
  app: identifier,
  entrypoint: bindingName.default("default"),
});

export const capabilityGrants = z.record(bindingName, capabilityGrant);

export const publishedCapability = capabilityGrant.extend({
  organizationId: organizationIdentifier,
  hostname: z.string().regex(/^[a-z0-9.-]+$/),
});

export const capabilitySnapshot = z.strictObject({
  revision: z.number().int().nonnegative(),
  grants: capabilityGrants,
});

export const capabilityState = capabilitySnapshot.extend({
  appliedRevision: z.number().int().nonnegative().nullable(),
  state: z.enum(["saved", "pending", "active", "failed"]),
  error: z.string().nullable(),
});

export const appResource = z.strictObject({
  binding: bindingName,
  type: z.enum(["d1", "r2_bucket", "kv_namespace", "queue", "workflow", "assets"]),
  target: z.string(),
  databaseId: z.string().optional(),
});

export const appConnections = z.strictObject({
  deploymentId: identifier.nullable(),
  resources: z.array(appResource),
  connections: capabilityState,
  activeConnections: capabilityGrants.nullable(),
});

export const capabilityPath = appPath.extend({
  binding: bindingName.refine(
    (name) => !name.startsWith("WIDEFLEET_"),
    "Platform bindings are reserved",
  ),
});

export const connectionRequestInput = capabilityPath.extend(capabilityGrant.shape);

export const connectionRequestPath = z.strictObject({ requestId: identifier });

export const connectionRequest = z.strictObject({
  id: identifier,
  appId: identifier,
  appName: z.string(),
  serviceId: identifier,
  serviceName: z.string(),
  binding: bindingName,
  entrypoint: bindingName,
  requesterId: z.string(),
  requesterName: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  createdAt: z.iso.datetime(),
});

export const runtimePackages = z.strictObject({
  runtime: runtimeRelease,
  appSecrets: appSecretPreparation.optional(),
  serviceDocumentation: z
    .strictObject({
      artifactId: identifier,
      documentation: serviceDocumentation,
    })
    .optional(),
});

export const runtimeVersion = runtimeRelease.shape.version;

export const runtimeStatus = z.strictObject({
  desiredVersion: runtimeVersion.nullable(),
  jobId: z.uuid().nullable(),
  activeVersion: runtimeVersion.nullable(),
  state: z.enum(["pending", "queued", "running", "succeeded", "failed"]),
  message: z.string().nullable(),
  versions: z.array(runtimeVersion),
});

export const runtimeUpdate = z.strictObject({ version: runtimeVersion });

export const publishedApp = artifact.extend({
  origin: z.url().optional(),
  secretRevision: z.number().int().nonnegative().optional(),
  organizationId: organizationIdentifier.optional(),
  network: networkSnapshot,
  capabilities: z.record(bindingName, publishedCapability).default({}),
  capabilityRevision: z.number().int().nonnegative().default(0),
  version: identifier,
  deploymentId: identifier,
  hostname: z.string().regex(/^[a-z0-9.-]+$/),
  nativeBindings: z.record(bindingName, bindingName),
  telemetry: z.strictObject({ url: z.url(), token: z.string() }).nullable().default(null),
});

export const deletedApp = z.strictObject({ deleted: z.literal(true), appId: identifier });

export const publishedHost = z.union([publishedApp, deletedApp]);

export const organizationHttpAvailability = z.strictObject({ blocked: z.boolean() });

export const organizationHttpAvailabilityKey = (organizationId: string) =>
  `organizations/${organizationIdentifier.parse(organizationId)}/http-availability`;

export const agent = z.strictObject({
  id: identifier,
  name: z.string(),
  enabled: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
});

export const createAgentInput = z.strictObject({ name: z.string().trim().min(1).max(120) });

export const migrationArtifact = z.strictObject({
  sha256: checksum,
  // JSON escaping can expand SQL to six bytes per source byte.
  size: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
});

export const job = z.strictObject({
  id: identifier,
  organizationId: organizationIdentifier,
  kind: z.enum(["deploy", "runtime", "delete", "configure", "migrations", "workflows"]),
  workflow: workflowRequest.nullable().default(null),
  migration: migrationArtifact.nullable().default(null),
  access: appAccessSnapshot.nullable(),
  network: networkSnapshot.nullable(),
  capabilities: capabilitySnapshot.nullable().default(null),
  appId: identifier.nullable(),
  hostname: z.string().nullable(),
  origin: z.url().nullable().default(null),
  deploymentId: identifier.nullable(),
  artifactId: identifier.nullable(),
  attempt: z.number().int().positive(),
  leaseToken: identifier,
  leaseUntil: z.iso.datetime(),
});

export const jobUpdate = z.strictObject({
  leaseToken: identifier,
  message: z.string().min(1).max(4096),
});

export const jobResult = jobUpdate.extend({
  outcome: z.enum(["succeeded", "failed"]),
  accessRevision: z.number().int().nonnegative().optional(),
  migrations: z.array(migrationEntry).max(1000).optional(),
  workflow: z.json().optional(),
});

export const rollbackInput = z.strictObject({ artifactId: identifier });

export const accessContext = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().nullable(),
  groups: z.array(z.string()),
});

export const logLevel = z.enum(["debug", "info", "warn", "error"]);

export const logSource = z.enum(["server", "browser", "runtime"]);

export const logTimestamp = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => (/\.(\d+)/.exec(value)?.[1]?.length ?? 0) <= 9,
    "Use at most nanosecond precision",
  );

export const logTime = z.union([logTimestamp, z.string().regex(/^[1-9][0-9]{0,5}[smhd]$/)]);

export const logQuery = appPath.extend({
  since: logTime.default("1h"),
  until: logTimestamp.optional(),
  level: logLevel.optional(),
  source: logSource.optional(),
  deploymentId: identifier.optional(),
  requestId: z.string().min(1).max(128).optional(),
  traceId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  query: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  // An ingestion watermark, independent of when the application emitted a log.
  receivedAfter: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .optional(),
  cursor: z.string().min(1).max(4096).optional(),
});

export const stackFrame = z.strictObject({
  generatedFile: z.string(),
  generatedLine: z.number().int(),
  generatedColumn: z.number().int(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  name: z.string().nullable(),
});

export const runtimeLog = z.strictObject({
  id: z.string(),
  timestamp: z.string(),
  receivedAt: z.string(),
  level: logLevel,
  source: logSource,
  kind: z.enum(["log", "request", "error", "span_error"]),
  message: z.string(),
  stack: z.string().nullable(),
  frames: z.array(stackFrame),
  buildId: z.string().nullable(),
  deploymentId: identifier.nullable(),
  requestId: z.string().nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  route: z.string().nullable(),
  status: z.number().int().nullable(),
  body: z.string(),
});

export const logPage = z.strictObject({
  entries: z.array(runtimeLog),
  nextCursor: z.string().nullable(),
  receivedThrough: z.string(),
  since: z.string(),
});

export const telemetryCredentials = z.strictObject({ token: z.string().min(1) }).nullable();

export * from "./settings.ts";
