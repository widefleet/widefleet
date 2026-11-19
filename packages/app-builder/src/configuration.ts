// Wrangler configuration as `widefleet deploy` reads it
// (crates/platform-cli/src/deploy.rs and worker.rs), and the Worker metadata
// it produces.
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

export const wranglerConfiguration = z.object({
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
});

export type WranglerConfiguration = z.infer<typeof wranglerConfiguration>;

// JSONC as Wrangler accepts it: line and block comments and trailing commas.
const stripJsonc = (text: string) => {
  let output = "";
  let index = 0;

  while (index < text.length) {
    const character = text.charAt(index);
    const next = text.charAt(index + 1);

    if (character === '"') {
      const start = index;
      index++;

      while (index < text.length && text.charAt(index) !== '"')
        index += text.charAt(index) === "\\" ? 2 : 1;
      output += text.slice(start, index + 1);
      index++;
    } else if (character === "/" && next === "/") {
      while (index < text.length && text.charAt(index) !== "\n") index++;
    } else if (character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      // A comma before a closing bracket, outside strings, is a trailing comma.
      if (character === "}" || character === "]") output = output.replace(/,(\s*)$/, "$1");
      output += character;
      index++;
    }
  }

  return output;
};

export const readConfiguration = (files: Readonly<Record<string, string>>) => {
  const source = files["wrangler.jsonc"] ?? files["wrangler.json"];

  if (source === undefined)
    throw new BuildError("The project has no wrangler.jsonc or wrangler.json");

  const parsed = wranglerConfiguration.safeParse(parseJson(stripJsonc(source), "wrangler.jsonc"));

  if (!parsed.success)
    throw new BuildError(`Invalid Wrangler configuration: ${z.prettifyError(parsed.error)}`);

  if (parsed.data.assets)
    throw new BuildError("Projects with static assets are deployed with the Widefleet CLI");

  return parsed.data;
};

export class BuildError extends Error {}

/** Parses a project file as JSON, reporting invalid JSON as a build error. */
export const parseJson = (text: string, file: string) => {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    throw new BuildError(`${file} is not valid JSON`);
  }
};

/** Worker metadata in the order `widefleet deploy` writes bindings. */
export const workerMetadata = (
  configuration: WranglerConfiguration,
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
    // Service entrypoints are module exports; Workflow classes are not.
    web: exports.includes("default"),
    entrypoints: exports.filter(
      (name) => !configuration.workflows.some((workflow) => workflow.class_name === name),
    ),
    crons: configuration.triggers.crons,
    queue_consumers: configuration.queues.consumers,
  });
