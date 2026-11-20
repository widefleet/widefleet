// Bundles an app project as `widefleet deploy` does
// (crates/platform-cli/src/deploy.rs `bundle`): browser platform, Node
// built-ins external with nodejs_compat, the builtin `require` bridge and an
// external source map.
import { createWorker, InMemoryFileSystem, installDependencies } from "@cloudflare/worker-bundler";
import { bundleResult } from "@platform/contracts/builds";
import { parse } from "es-module-lexer/js";
import { z } from "zod";
import { BuildError, readConfiguration, readDeclaration, workerMetadata } from "./configuration.ts";
import { dependencyPatches, projectPatches } from "./patches.ts";

const builtins = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "sqlite",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
];

// celld resolves only builtins through this bridge; npm code stays bundled.
const requireBuiltin = `var require = (specifier) => {
  const builtin = globalThis.process.getBuiltinModule(specifier);
  if (builtin !== undefined) return builtin;
  throw Object.assign(new Error(\`Cannot find module '\${specifier}'\`), { code: "MODULE_NOT_FOUND" });
};`;

// Dependencies install without their source maps, which keeps the build's
// memory low, so esbuild cannot read the maps their modules reference. Stack
// traces then point into the package's published code.
const packageSourceMap = /^Cannot read file "node_modules\/[^"]+\.map": /;

const inlineMap = /\n\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/;

const sourceMap = z.looseObject({ sources: z.array(z.string()), mappings: z.string() });

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

// Decode in place; Uint8Array.from over a multi-megabyte string would first
// collect every code unit into a list.
const decodeBase64 = (text: string) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  return new TextDecoder().decode(bytes);
};

// Externals match exactly or by subpath; `cloudflare:` and `node:` by prefix.
const allowedExternal = (name: string, externals: readonly string[]) =>
  name.startsWith("cloudflare:") ||
  externals.some(
    (external) =>
      name === external ||
      name.startsWith(`${external}/`) ||
      (external.endsWith(":") && name.startsWith(external)),
  );

const buildFailure = z.object({
  message: z.string(),
  errors: z.array(z.object({ text: z.string() })).min(1),
});

// esbuild failures carry source diagnostics; report them as build errors.
const bundleProject = async (options: Parameters<typeof createWorker>[0]) => {
  try {
    return await createWorker(options);
  } catch (error) {
    const failure = buildFailure.safeParse(error);

    if (failure.success) throw new BuildError(failure.data.message.replaceAll("virtual:", ""));

    throw error;
  }
};

export const bundle = async (files: Readonly<Record<string, string>>, registry: string) => {
  const configuration = readConfiguration(files);
  const declaration = readDeclaration(files);
  const entry = configuration.main.replace(/^\.\//, "");

  if (files[entry] === undefined) throw new BuildError(`The Worker entry ${entry} is missing`);
  const nodeCompat = configuration.compatibility_flags.includes("nodejs_compat");

  // createWorker derives the bundle platform from a Wrangler file: Node with
  // nodejs_compat. The CLI bundles for browsers, so the bundler receives the
  // sources without the Wrangler file and the entry explicitly.
  const project = new InMemoryFileSystem(
    Object.fromEntries(
      Object.entries(files).filter(
        ([path]) => path !== "wrangler.jsonc" && path !== "wrangler.json",
      ),
    ),
  );

  const patches = dependencyPatches(projectPatches(files));

  // Installs only files a bundle reads; createWorker then finds the packages.
  const installed = await installDependencies(project, {
    files: "build",
    registry,
    patchPackage: patches.patchPackage,
  });

  patches.verify(installed.installed);

  const externals = [
    "cloudflare:workers",
    "cloudflare:workflows",
    "cloudflare:sockets",
    "node:async_hooks",
    ...(nodeCompat ? ["node:", ...builtins] : []),
  ];

  const bundled = await bundleProject({
    files: project,
    entryPoint: entry,
    sourcemap: true,
    // Stack traces need positions only; the control plane does not read
    // embedded sources and documentation reads the original files. Embedding
    // them would roughly double esbuild's source map memory.
    sourcesContent: false,
    target: "es2022",
    externals,
    conditions: nodeCompat ? ["workerd", "worker", "browser"] : [],
    registry,
  });

  const output = z.string().parse(bundled.modules[bundled.mainModule]);
  const inline = inlineMap.exec(output);
  const encodedMap = inline?.[1];

  if (!inline || encodedMap === undefined)
    throw new BuildError("The bundler returned no source map");
  const map = sourceMap.parse(JSON.parse(decodeBase64(encodedMap)));
  const banner = nodeCompat ? `${requireBuiltin}\n` : "";

  // esbuild writes a banner above the bundle; shift the mappings by its lines.
  map.mappings = ";".repeat(banner.split("\n").length - 1) + map.mappings;
  map.sources = map.sources.map((source) => source.replace(/^virtual:/, ""));

  const worker = `${banner}${output.slice(0, inline.index)}\n//# sourceMappingURL=worker.js.map\n`;
  const [imported, exported] = parse(worker);

  // The bundler leaves imports it cannot resolve external; esbuild, and with it
  // the CLI, reports them instead.
  const unresolved = imported
    .map((entry) => entry.n)
    .filter((name): name is string => name !== undefined)
    .filter((name) => !allowedExternal(name, externals));

  if (unresolved.length > 0)
    throw new BuildError(`Could not resolve ${[...new Set(unresolved)].join(", ")}`);
  const mapText = JSON.stringify(map);
  // As the CLI: the map module is named by its digest, so the build ID covers it.
  const sourceMaps = { "worker.js": `map-${await sha256(mapText)}.map` };

  return bundleResult.parse({
    worker,
    map: mapText,
    entry,
    metadata: workerMetadata(
      configuration,
      declaration,
      exported.map((name) => name.n),
      {
        // As the CLI: the bundle's digest with its source map names.
        build_id: await sha256(JSON.stringify([await sha256(worker), sourceMaps])),
        source_maps: sourceMaps,
      },
    ),
    warnings: [
      ...installed.warnings,
      ...(bundled.warnings ?? []).filter((warning) => !packageSourceMap.test(warning)),
    ],
  });
};
