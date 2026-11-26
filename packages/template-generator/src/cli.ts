// Generates a template's typed API from its provider's published description.
//
//   pnpm --filter @platform/template-generator generate <template | app-directory> [source-file]
//
// A template name regenerates the template in this repository; a directory
// regenerates an app copied from a template. Its scripts/operations.ts names
// the source and decides how each operation is offered. Without a source file,
// the generator downloads the current description, through the rules' own
// `download` where the provider publishes it only inside another document, or
// in parts, such as one page per operation, which the generator joins. An
// OpenAPI description may refer to schemas in other files; with a source file,
// the generator reads those next to it, at their path relative to the source's
// URL. It writes the generated files and the shared runtime files into the
// template or app; review the diff before committing.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { generateDiscovery } from "./discovery.ts";
import { generateGraphql } from "./graphql.ts";
import { generateOpenapi, mergeDescriptions, parseDescription } from "./openapi.ts";
import { bundleReferences, localCopy } from "./references.ts";

const [target, sourceArgument] = process.argv.slice(2);

if (!target) throw new Error("Usage: generate <template | app-directory> [source-file]");

const here = dirname(fileURLToPath(import.meta.url));

// pnpm runs the script in this package; paths are relative to where it was started.
const started = process.env["INIT_CWD"] ?? process.cwd();

const template = /^[a-z0-9-]+$/.test(target) ? target : null;

const directory = template ? join(here, "../../../templates", template) : resolve(started, target);

const sourcePath = sourceArgument ? resolve(started, sourceArgument) : undefined;

const service = z.object({
  name: z.string(),
  className: z.string(),
  result: z.string(),
  properties: z.string(),
});

const change = z.enum(["create", "update", "delete", "send"]);

const hidden = z.object({ hidden: z.string() });

const headers = z.record(z.string(), z.object({ name: z.string(), description: z.string() }));

const configuration = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("graphql"),
    generator: z.object({ kind: z.literal("graphql"), source: z.url(), service }),
    mutations: z.record(z.string(), z.union([change, hidden])),
    queries: z.record(z.string(), z.union([hidden, z.object({ name: z.string() })])),
  }),
  z.object({
    kind: z.literal("discovery"),
    generator: z.object({ kind: z.literal("discovery"), source: z.url(), service }),
    operations: z.record(z.string(), z.union([change, z.literal("read"), hidden])),
    scopes: z.array(z.string()).optional(),
    required: z.record(z.string(), z.array(z.string())).optional(),
    nullableValues: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("openapi"),
    generator: z.object({
      kind: z.literal("openapi"),
      source: z.url(),
      service: service.extend({ typePrefix: z.string().optional() }),
    }),
    operations: z.record(
      z.string(),
      z.object({
        name: z.string(),
        change: z.union([change, z.literal("read")]).optional(),
        description: z.string().optional(),
        body: z.array(z.string()).optional(),
        result: z.array(z.string()).optional(),
        headers: headers.optional(),
        parameters: z.array(z.json()).optional(),
        fields: z.record(z.string(), z.json()).optional(),
        form: z.json().optional(),
        requiredBody: z.boolean().optional(),
      }),
    ),
    navigation: z.record(z.string(), z.record(z.string(), z.array(z.string()))).optional(),
    bindings: z.record(z.string(), z.array(z.string())).optional(),
    undescribed: z
      .record(
        z.string(),
        z.object({
          operation: z.string(),
          method: z.enum(["post", "put", "patch", "delete"]),
          change,
          description: z.string(),
          body: z.array(z.string()),
          result: z.array(z.string()).optional(),
          headers: headers.optional(),
        }),
      )
      .optional(),
  }),
]);

const exported = z
  .object({
    generator: z.looseObject({ kind: z.string() }),
    download: z
      .function({ input: [], output: z.promise(z.union([z.string(), z.array(z.string())])) })
      .optional(),
  })
  .loose()
  .parse(await import(pathToFileURL(join(directory, "scripts/operations.ts")).href));

const rules = configuration.parse({ ...exported, kind: exported.generator.kind });

const { generator } = rules;

const download = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);

  return response.text();
};

const source = sourcePath
  ? readFileSync(sourcePath, "utf8")
  : exported.download
    ? await exported.download()
    : await download(generator.source);

// A description published in parts is generated as one document; a saved copy is that document.
if (Array.isArray(source) && rules.kind !== "openapi")
  throw new Error(`A ${rules.kind} description cannot be published in parts`);

const text = Array.isArray(source)
  ? JSON.stringify(mergeDescriptions(source.map(parseDescription)))
  : source;

// A file the description refers to: next to the source file when there is one
// at the same path relative to the source's URL, otherwise downloaded.
const load = async (url: string) => {
  const local = sourcePath ? localCopy(url, generator.source, sourcePath) : null;

  return parseDescription(
    local && existsSync(local) ? readFileSync(local, "utf8") : await download(url),
  );
};

const header = `// Generated by the Widefleet template generator from ${generator.service.name}'s
// published API description and scripts/operations.ts. Do not edit; regenerate
// from the Widefleet repository:
//   pnpm --filter @platform/template-generator generate ${template ?? "<this app's directory>"}
`;

const generated =
  rules.kind === "graphql"
    ? generateGraphql(text, rules, rules.generator.service, header)
    : rules.kind === "discovery"
      ? generateDiscovery(text, rules, rules.generator.service, header)
      : generateOpenapi(
          await bundleReferences(parseDescription(text), generator.source, load),
          rules,
          rules.generator.service,
          header,
        );

const written = Object.entries(generated.files).map(([path, text]) => {
  writeFileSync(join(directory, path), text);

  return join(directory, path);
});

// Whether a method changes data. Templates that only read never ask, so they
// leave out the approval files.
const changes =
  rules.kind === "graphql"
    ? Object.values(rules.mutations).some((mutation) => change.safeParse(mutation).success)
    : rules.kind === "discovery"
      ? Object.values(rules.operations).some((value) => change.safeParse(value).success)
      : Object.values(rules.operations).some((value) => change.safeParse(value.change).success) ||
        Object.keys(rules.undescribed ?? {}).length > 0;

// Files the generated code calls, kept once in this package. A template writes
// its page and its approval levels itself.
const runtime = [
  "selection.ts",
  ...(changes ? ["approval.ts", "approval-methods.ts"] : []),
  "input.ts",
  ...{
    graphql: ["graphql.ts"],
    discovery: ["google.ts", "content.ts"],
    openapi: ["rest.ts", "content.ts"],
  }[rules.kind],
];

for (const file of runtime) copyFileSync(join(here, "runtime", file), join(directory, "src", file));

// Formatted as the repository formats its sources, so regenerating changes only what changed.
execFileSync(join(here, "../../../node_modules/.bin/oxfmt"), written, { stdio: "inherit" });

console.log(generated.summary);
