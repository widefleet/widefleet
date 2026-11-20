// The app builder's API: the control plane sends an app project's source files
// and receives the Worker module, its source map and its metadata, as
// `widefleet deploy` would upload them.
import { z } from "zod";
import { bindingName, queueConsumer, serviceDocumentation, workerConfiguration } from "./index.ts";
import { networkDeclaration } from "./network.ts";

const maximumSourceBytes = 16 * 1024 * 1024;

export const buildSourcePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Source paths are relative paths inside the project",
  );

/** An app project's source files by relative path. */
export const buildSources = z
  .record(buildSourcePath, z.string())
  .refine((files) => Object.keys(files).length <= 2000, "A project has at most 2000 source files")
  .refine(
    (files) =>
      Object.values(files).reduce(
        (total, content) => total + new TextEncoder().encode(content).byteLength,
        0,
      ) <= maximumSourceBytes,
    "Project sources exceed 16 MiB",
  );

export const bundleRequest = z.strictObject({ files: buildSources });

export const builtWorker = workerConfiguration.extend({
  web: z.boolean(),
  entrypoints: z.array(bindingName).max(32),
  crons: z.array(z.string().min(1)),
  queue_consumers: z.array(queueConsumer),
  network: networkDeclaration.optional(),
});

export const bundleResult = z.strictObject({
  /** The bundled ES module, uploaded as `worker.js`. */
  worker: z.string(),
  /** The bundle's source map, uploaded privately as `worker.js.map`. */
  map: z.string(),
  /** The original entry module, which documentation checks. */
  entry: buildSourcePath,
  metadata: builtWorker,
  warnings: z.array(z.string()),
});

export const documentRequest = z.strictObject({
  files: buildSources,
  worker: z.string(),
  map: z.string(),
  entry: buildSourcePath,
  entrypoints: z.array(bindingName).max(32),
});

export const documentResult = z.strictObject({
  documentation: serviceDocumentation,
  /** Declarations that could not be installed, which leaves their types unknown. */
  warnings: z.array(z.string()),
});

export const buildFailure = z.strictObject({ message: z.string() });
