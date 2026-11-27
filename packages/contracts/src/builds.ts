// The builders' APIs. The app builder receives an app project's source files
// and returns the Worker module, its source map and its metadata, as
// `widefleet deploy` would upload them. The app CI runs `widefleet deploy` on a
// commit from Widefleet Git.
import { z } from "zod";
import {
  appIconSource,
  identifier,
  sourceCredential,
  sourceRevision,
  bindingName,
  generatedAppIcons,
  queueConsumer,
  requiredSecrets,
  serviceDocumentation,
  workerConfiguration,
} from "./index.ts";
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
  required_secrets: requiredSecrets.optional(),
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

/** `/favicon.svg`, base64-encoded, to render as PNG app icons. */
export const iconsRequest = z.strictObject({
  svg: z.base64().max(Math.ceil(appIconSource.maxBytes / 3) * 4),
});

export const iconsResult = z.strictObject({
  icons: z.array(
    z.strictObject({
      path: z.literal(generatedAppIcons.map((icon) => icon.path)),
      png: z.base64(),
    }),
  ),
});

export const encodeBase64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

export const decodeBase64 = (text: string) =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

export const buildFailure = z.strictObject({ message: z.string() });

/** A commit for the app CI to deploy, under the build's ID. */
export const ciBuildRequest = z.strictObject({
  id: z.uuid(),
  appId: identifier,
  /** The control plane, where the build deploys through the CI with the build's token. */
  platform: z.strictObject({
    url: z.url({ protocol: /^https?$/ }),
    organizationId: z.string().min(1),
    token: z.string().min(1),
  }),
  /** The app's repository, which the CI reads with credentials of the build. */
  repository: z.strictObject({ url: sourceCredential.shape.url }),
  source: sourceRevision,
});

export const ciBuildResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), log: z.string() }),
  z.strictObject({ status: z.literal("failed"), message: z.string(), log: z.string() }),
]);
