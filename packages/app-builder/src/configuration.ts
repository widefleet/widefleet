// Wrangler configuration as `widefleet deploy` reads it
// (crates/platform-cli/src/deploy.rs and worker.rs), and the Worker metadata
// it produces.
import { appDeclaration } from "@platform/contracts";
import { stripJsonc } from "@platform/contracts/jsonc";
import { builtWorker } from "@platform/contracts/builds";
import { z } from "zod";

const database = z.strictObject({
  binding: z.string(),
  database_name: z.string(),
  database_id: z.string().optional(),
  migrations_dir: z.string().optional(),
  migrations_pattern: z.string().optional(),
  migrations_table: z.string().optional(),
});

const queueConsumer = z.strictObject({
  queue: z.string(),
  max_batch_size: z.number().int().optional(),
  max_batch_timeout: z.number().int().optional(),
  max_retries: z.number().int().optional(),
  retry_delay: z.number().int().optional(),
  dead_letter_queue: z.string().optional(),
});

// As the CLI, unknown keys are errors: a misspelled key must not be ignored.
export const wranglerConfiguration = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().optional(),
  main: z.string(),
  compatibility_date: z.string(),
  compatibility_flags: z
    .array(
      z.enum(
        ["nodejs_als", "nodejs_compat"],
        "Supported compatibility flags are nodejs_als and nodejs_compat",
      ),
    )
    .refine((flags) => new Set(flags).size === flags.length, "Compatibility flags must be unique")
    .default([]),
  vars: z.record(z.string(), z.string()).default({}),
  d1_databases: z.array(database).default([]),
  r2_buckets: z.array(z.strictObject({ binding: z.string(), bucket_name: z.string() })).default([]),
  kv_namespaces: z.array(z.strictObject({ binding: z.string(), id: z.string() })).default([]),
  assets: z.strictObject({ directory: z.string(), binding: z.string() }).optional(),
  triggers: z.strictObject({ crons: z.array(z.string()).default([]) }).default({ crons: [] }),
  queues: z
    .strictObject({
      producers: z.array(z.strictObject({ binding: z.string(), queue: z.string() })).default([]),
      consumers: z.array(queueConsumer).default([]),
    })
    .default({ producers: [], consumers: [] }),
  workflows: z
    .array(z.strictObject({ binding: z.string(), name: z.string(), class_name: z.string() }))
    .default([]),
  no_bundle: z.boolean().optional(),
});

export type WranglerConfiguration = z.infer<typeof wranglerConfiguration>;

export const readConfiguration = (files: Readonly<Record<string, string>>) => {
  const source = files["wrangler.jsonc"] ?? files["wrangler.json"];

  if (source === undefined)
    throw new BuildError("The project has no wrangler.jsonc or wrangler.json");

  const parsed = wranglerConfiguration.safeParse(parseJsonc(source, "wrangler.jsonc"));

  if (!parsed.success)
    throw new BuildError(`Invalid Wrangler configuration: ${z.prettifyError(parsed.error)}`);

  return parsed.data;
};

export class BuildError extends Error {}

/** Parses JSONC, as Wrangler and TypeScript accept it, reporting invalid input as a build error. */
export const parseJsonc = (text: string, file: string) => parseJson(stripJsonc(text), file);

/** Parses a project file as JSON, reporting invalid JSON as a build error. */
export const parseJson = (text: string, file: string) => {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    throw new BuildError(`${file} is not valid JSON`);
  }
};

/** Worker metadata in the order `widefleet deploy` writes bindings. */
/** widefleet.jsonc beside the Wrangler configuration, as `widefleet deploy` reads it. */
export const readDeclaration = (files: Readonly<Record<string, string>>) => {
  const source = files["widefleet.jsonc"];

  if (source === undefined) return {};
  const parsed = appDeclaration.safeParse(parseJsonc(source, "widefleet.jsonc"));

  if (!parsed.success)
    throw new BuildError(`Invalid widefleet.jsonc: ${z.prettifyError(parsed.error)}`);

  return parsed.data;
};

export const workerMetadata = (
  configuration: WranglerConfiguration,
  declaration: ReturnType<typeof readDeclaration>,
  exports: readonly string[],
  debug: { build_id: string; source_maps: Record<string, string> },
) =>
  builtWorker.parse({
    main_module: "worker.js",
    compatibility_date: configuration.compatibility_date,
    compatibility_flags: configuration.compatibility_flags,
    bindings: [
      ...Object.entries(configuration.vars).map(([name, text]) => ({
        type: "plain_text",
        name,
        text,
      })),
      ...configuration.d1_databases.map((entry) => ({
        type: "d1",
        name: entry.binding,
        database_name: entry.database_name,
        database_id: entry.database_id,
      })),
      ...configuration.r2_buckets.map((bucket) => ({
        type: "r2_bucket",
        name: bucket.binding,
        bucket_name: bucket.bucket_name,
      })),
      ...configuration.kv_namespaces.map((namespace) => ({
        type: "kv_namespace",
        name: namespace.binding,
        id: namespace.id,
      })),
      ...configuration.queues.producers.map((producer) => ({
        type: "queue",
        name: producer.binding,
        queue: producer.queue,
      })),
      ...configuration.workflows.map((workflow) => ({
        type: "workflow",
        name: workflow.binding,
        workflow_name: workflow.name,
        class_name: workflow.class_name,
      })),
    ],
    debug,
    // As the CLI: static assets or a default export give the app a URL.
    // Service entrypoints are module exports; Workflow classes are not.
    web: configuration.assets !== undefined || exports.includes("default"),
    entrypoints: exports.filter(
      (name) => !configuration.workflows.some((workflow) => workflow.class_name === name),
    ),
    crons: configuration.triggers.crons,
    queue_consumers: configuration.queues.consumers,
    network: declaration.network,
  });
