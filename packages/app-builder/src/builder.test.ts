import {
  buildFailure,
  bundleRequest,
  bundleResult,
  documentRequest,
  documentResult,
} from "@platform/contracts/builds";
import { Miniflare, Request, Response } from "miniflare";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

// Built by `pnpm --filter @platform/app-builder build` after the service
// documentation module (see build.ts).
const dist = (file: string) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url).href);

const registry = "https://registry.example.test";

const encoder = new TextEncoder();

// A gzipped tar archive with the files under package/, as npm packs packages.
const tarball = (files: Readonly<Record<string, string>>) => {
  const blocks: Uint8Array[] = [];

  for (const [name, content] of Object.entries(files)) {
    const body = encoder.encode(content);
    const header = new Uint8Array(512);
    const write = (offset: number, text: string) => header.set(encoder.encode(text), offset);

    write(0, `package/${name}`);
    write(100, "0000644\0");
    write(108, "0000000\0");
    write(116, "0000000\0");
    write(124, `${body.length.toString(8).padStart(11, "0")}\0`);
    write(136, "00000000000\0");
    write(148, "        ");
    write(156, "0");
    write(257, "ustar\0");
    write(263, "00");
    write(
      148,
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
    );
    blocks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }

  const archive = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0) + 1024);

  let offset = 0;

  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }

  return new Uint8Array(gzipSync(archive));
};

const packages = {
  greeting: {
    "package.json": JSON.stringify({ name: "greeting", version: "1.0.0", main: "index.js" }),
    // Published with a source map, which the build does not install.
    "index.js":
      "export const greet = (name) => `Hello ${name}`;\n//# sourceMappingURL=index.js.map\n",
    "index.js.map": JSON.stringify({ version: 3, sources: ["index.ts"], names: [], mappings: "" }),
    "index.d.ts": "export declare const greet: (name: string) => string;\n",
    "README.md": "# greeting\n",
  },
  // Selects its build by export condition, as several Workers libraries do.
  "runtime-variant": {
    "package.json": JSON.stringify({
      name: "runtime-variant",
      version: "1.2.0",
      exports: {
        ".": {
          types: "./index.d.ts",
          workerd: "./workerd.js",
          node: "./node.js",
          default: "./default.js",
        },
      },
    }),
    "workerd.js": 'export const runtime = "workerd build";\n',
    "node.js": 'export const runtime = "node build";\n',
    "default.js": 'export const runtime = "default build";\n',
    "index.d.ts": "export declare const runtime: string;\n",
  },
  // A no-op module, as browser replacements often are.
  "empty-module": {
    "package.json": JSON.stringify({ name: "empty-module", version: "1.0.0", main: "empty.js" }),
    "empty.js": "",
  },
  // Code named like documentation stays installed.
  licensed: {
    "package.json": JSON.stringify({ name: "licensed", version: "1.0.0", main: "license.js" }),
    "license.js": 'export const license = "MIT";\n',
    LICENSE: "MIT License\n",
  },
  // Separate entries for import and require, as dual packages publish them.
  dual: {
    "package.json": JSON.stringify({
      name: "dual",
      version: "1.0.0",
      exports: { ".": { import: "./esm.mjs", require: "./cjs.js" } },
    }),
    "esm.mjs": 'export default () => "esm build";\n',
    "cjs.js": 'module.exports = () => "cjs build";\n',
  },
  // CommonJS that requires the dual package.
  "cjs-consumer": {
    "package.json": JSON.stringify({
      name: "cjs-consumer",
      version: "1.0.0",
      main: "index.js",
      dependencies: { dual: "1.0.0" },
    }),
    "index.js": 'module.exports = { viaRequire: require("dual")() };\n',
  },
  // Types published as TypeScript sources rather than declaration files.
  "source-types": {
    "package.json": JSON.stringify({
      name: "source-types",
      version: "1.0.0",
      exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" } },
    }),
    "src/index.ts": "/** A note to file. */\nexport interface Note {\n  title: string;\n}\n",
    "dist/index.js": "export {};\n",
  },
  // Types only, used by a public method and erased from the bundle.
  "shape-types": {
    "package.json": JSON.stringify({ name: "shape-types", version: "2.0.0", types: "index.d.ts" }),
    "index.d.ts": "/** A shape to measure. */\nexport interface Shape {\n  size: number;\n}\n",
    // Published, but not named as the types until a patch changes the manifest.
    "src/published.ts":
      "/** A shape from its published source. */\nexport interface Shape {\n  size: number;\n}\n",
  },
};

const packageFiles = new Map<string, Readonly<Record<string, string>>>(Object.entries(packages));

const archives = new Map([...packageFiles].map(([name, files]) => [name, tarball(files)] as const));

const registryRequests: string[] = [];

// The registry metadata and tarballs the installer requests.
const registryResponse = (request: Request) => {
  const url = new URL(request.url);
  registryRequests.push(url.pathname);
  const [, name, separator] = url.pathname.split("/");
  const files = name === undefined ? undefined : packageFiles.get(name);
  const archive = name === undefined ? undefined : archives.get(name);

  if (url.origin !== registry || !name || !files || !archive)
    return new Response("Not found", { status: 404 });

  if (separator === "-") return new Response(archive);

  // Version metadata repeats the package's manifest, as npm serves it.
  const manifest = z
    .looseObject({ version: z.string() })
    .parse(JSON.parse(files["package.json"] ?? "{}"));

  const { version } = manifest;

  return Response.json({
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        ...manifest,
        name,
        version,
        dist: { tarball: `${registry}/${name}/-/${name}-${version}.tgz` },
      },
    },
  });
};

const project = {
  "wrangler.jsonc": `{
  // Wrangler accepts comments and trailing commas.
  "name": "fixture",
  "main": "src/app.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": { "GREETING": "hi", "PATTERN": "[,}]" },
  "d1_databases": [{ "binding": "DB", "database_name": "accounts" }],
  "triggers": { "crons": ["0 * * * *"] },
}
`,
  "package.json": JSON.stringify({
    name: "fixture",
    private: true,
    dependencies: {
      greeting: "1.0.0",
      "runtime-variant": "^1.0.0",
      "empty-module": "1.0.0",
      licensed: "1.0.0",
      "cjs-consumer": "1.0.0",
    },
    devDependencies: { "shape-types": "2.0.0", "source-types": "1.0.0" },
  }),
  "tsconfig.json": `{
  // TypeScript accepts comments and trailing commas.
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
  },
  "include": ["src"],
}
`,
  "src/app.ts": `import "empty-module";
import { greet } from "greeting";
import { license } from "licensed";
import { viaRequire } from "cjs-consumer";
import { runtime } from "runtime-variant";
import type { Shape } from "shape-types";
import type { Note } from "source-types";

export default {
  /**
   * Greet someone.
   * @param name Who to greet.
   */
  async greet(name: string): Promise<string> {
    return \`\${greet(name)} from \${runtime} under \${license} via \${viaRequire}\`;
  },

  /** Measure a shape. */
  async measure(shape: Shape): Promise<number> {
    return shape.size;
  },

  /** File a note. */
  async file(note: Note): Promise<string> {
    return note.title;
  },
};
`,
};

describe.runIf(process.env["RUN_BUILDER_TESTS"] === "1")("app builder", () => {
  let builder: Miniflare;

  const post = (
    path: string,
    body: z.input<typeof bundleRequest> | z.input<typeof documentRequest>,
  ) =>
    builder.dispatchFetch(`https://builder.example.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const failure = async (response: Awaited<ReturnType<typeof post>>) =>
    buildFailure.parse(await response.json()).message;

  beforeAll(async () => {
    const module = async (name: string) => new Uint8Array(await readFile(dist(name)));

    builder = new Miniflare({
      workers: [
        {
          config: {
            name: "builder",
            compatibilityDate: "2026-10-01",
            manifest: {
              mainModule: "builder.js",
              modules: {
                "builder.js": {
                  type: "esm",
                  contents: await readFile(dist("builder.js"), "utf8"),
                },
                "esbuild.wasm": { type: "wasm", contents: await module("esbuild.wasm") },
                "service-docs.wasm": { type: "wasm", contents: await module("service-docs.wasm") },
              },
            },
            env: {
              NPM_REGISTRY: { type: "json", value: registry },
            },
          },
          dev: { outboundService: { type: "fetcher", handler: registryResponse } },
        },
      ],
    });
    await builder.ready;
  });

  afterAll(async () => {
    await builder.dispose();
  });

  it("bundles and documents an app as widefleet deploy does", async () => {
    const bundled = await post("/bundle", { files: project });
    expect(bundled.status).toBe(200);
    const result = bundleResult.parse(await bundled.json());

    expect(result.entry).toBe("src/app.ts");
    expect(result.warnings).toEqual([]);
    expect(result.metadata).toMatchObject({
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "plain_text", name: "GREETING", text: "hi" },
        // Commas inside strings are not trailing commas.
        { type: "plain_text", name: "PATTERN", text: "[,}]" },
        { type: "d1", name: "DB", database_name: "accounts" },
      ],
      web: true,
      entrypoints: ["default"],
      crons: ["0 * * * *"],
      queue_consumers: [],
    });
    expect(result.metadata.debug?.build_id).toMatch(/^[0-9a-f]{64}$/);
    // As the CLI names maps: by digest, so the build ID covers the map.
    expect(result.metadata.debug?.source_maps["worker.js"]).toMatch(/^map-[0-9a-f]{64}\.map$/);
    // nodejs_compat bundles keep built-ins external behind the CLI's require bridge.
    expect(result.worker.startsWith("var require = (specifier) => {")).toBe(true);
    expect(result.worker).toContain("workerd build");
    expect(result.worker).not.toContain("node build");
    expect(result.worker).toContain('"MIT"');
    // require() selects the dual package's CommonJS entry, as esbuild does.
    expect(result.worker).toContain("cjs build");
    expect(result.worker).not.toContain("esm build");
    expect(result.worker.trimEnd().endsWith("//# sourceMappingURL=worker.js.map")).toBe(true);

    const map = z
      .looseObject({ sources: z.array(z.string()), mappings: z.string() })
      .parse(JSON.parse(result.map));

    expect(map.sources).toContain("src/app.ts");
    expect(map).not.toHaveProperty("sourcesContent");
    // The bridge's five lines precede the bundle's first mapped line.
    expect(map.mappings.startsWith(";;;;;")).toBe(true);

    const documented = await post("/document", {
      files: project,
      worker: result.worker,
      map: result.map,
      entry: result.entry,
      entrypoints: result.metadata.entrypoints,
    });

    expect(documented.status).toBe(200);
    const { documentation, warnings } = documentResult.parse(await documented.json());

    expect(warnings).toEqual([]);

    expect(documentation.entrypoints).toEqual([
      expect.objectContaining({
        name: "default",
        methods: [
          expect.objectContaining({
            name: "greet",
            summary: "Greet someone.",
            signatures: [
              {
                parameters: [
                  {
                    name: "name",
                    type: "string",
                    description: "Who to greet.",
                    optional: false,
                    rest: false,
                  },
                ],
                returns: { type: "Promise<string>", description: "" },
              },
            ],
          }),
          expect.objectContaining({
            name: "measure",
            summary: "Measure a shape.",
            signatures: [
              expect.objectContaining({
                // Resolved from the installed declarations; without them it would be `any`.
                parameters: [
                  expect.objectContaining({
                    name: "shape",
                    type: 'import("./node_modules/shape-types/index").Shape',
                  }),
                ],
              }),
            ],
          }),
          expect.objectContaining({
            name: "file",
            summary: "File a note.",
            signatures: [
              expect.objectContaining({
                // Resolved from the package's TypeScript sources.
                parameters: [
                  expect.objectContaining({
                    name: "note",
                    type: 'import("./node_modules/source-types/src/index").Note',
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ]);
    // The type-only development dependency is installed for documentation.
    expect(documentation.types).toEqual([
      expect.objectContaining({
        name: 'import("./node_modules/shape-types/index").Shape',
        definition: "{\n    size: number;\n}",
        summary: "A shape to measure.",
      }),
      expect.objectContaining({
        name: 'import("./node_modules/source-types/src/index").Note',
        summary: "A note to file.",
      }),
    ]);
    expect(registryRequests).toEqual(expect.arrayContaining(["/greeting", "/runtime-variant"]));
  });

  it("derives the build ID from the bundle and its source map", async () => {
    const build = async (files: Record<string, string>) =>
      bundleResult.parse(await (await post("/bundle", { files })).json());

    const first = await build(project);
    // Comments change source map positions but not the bundle.

    const second = await build({
      ...project,
      "src/app.ts": `// A note.\n${project["src/app.ts"]}`,
    });

    expect(second.worker).toBe(first.worker);
    expect(second.map).not.toBe(first.map);
    expect(second.metadata.debug?.build_id).not.toBe(first.metadata.debug?.build_id);
  });

  it("reports source errors as the CLI's bundler does", async () => {
    const syntax = await post("/bundle", {
      files: { ...project, "src/app.ts": "export default {\n  async greet( {\n};\n" },
    });

    expect(syntax.status).toBe(422);
    expect(await failure(syntax)).toMatch(/src\/app\.ts:\d+:\d+: ERROR:/);

    const relative = await post("/bundle", {
      files: {
        ...project,
        "src/app.ts": 'import { value } from "./missing.ts";\nexport default { value };\n',
      },
    });

    expect(relative.status).toBe(422);
    expect(await failure(relative)).toBe("Could not resolve ./missing.ts");

    const dependency = await post("/bundle", {
      files: { ...project, "src/app.ts": 'import pad from "left-pad";\nexport default { pad };\n' },
    });

    expect(dependency.status).toBe(422);
    expect(await failure(dependency)).toBe("Could not resolve left-pad");

    // Code that only mentions a require() call in a string builds.
    const mentioned = await post("/bundle", {
      files: {
        ...project,
        "src/app.ts": "export default { fetch: () => new Response(\"__require('left-pad')\") };\n",
      },
    });

    expect(mentioned.status).toBe(200);

    // As with the CLI's esbuild, a require() of a package that is not
    // installed stays for run time, as optional dependencies use it.
    const optional = await post("/bundle", {
      files: {
        ...project,
        "src/app.ts":
          'let pad;\ntry {\n  pad = require("left-pad");\n} catch {}\nexport default { pad };\n',
      },
    });

    expect(optional.status).toBe(200);
  });

  it("reports project errors", async () => {
    const assets = await post("/bundle", {
      files: {
        ...project,
        "wrangler.jsonc": JSON.stringify({
          main: "src/app.ts",
          compatibility_date: "2026-10-01",
          assets: { directory: "public", binding: "ASSETS" },
        }),
        "src/app.ts":
          'import { WorkerEntrypoint } from "cloudflare:workers";\nexport class Notes extends WorkerEntrypoint {}\n',
      },
    });

    // The control plane uploads static assets; the bundle needs only the code.
    // As with the CLI, static assets give an app without a default export a URL.
    expect(assets.status).toBe(200);
    expect(bundleResult.parse(await assets.json()).metadata).toMatchObject({
      web: true,
      entrypoints: ["Notes"],
    });

    const flags = await post("/bundle", {
      files: {
        ...project,
        "wrangler.jsonc": JSON.stringify({
          main: "src/app.ts",
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat", "nodejs_compat"],
        }),
      },
    });

    expect(flags.status).toBe(422);
    expect(await failure(flags)).toContain("Compatibility flags must be unique");

    const entry = await post("/bundle", {
      files: Object.fromEntries(Object.entries(project).filter(([path]) => path !== "src/app.ts")),
    });

    expect(entry.status).toBe(422);
    expect(await failure(entry)).toBe("The Worker entry src/app.ts is missing");

    const unknown = await post("/bundle", {
      files: {
        ...project,
        "wrangler.jsonc": JSON.stringify({
          main: "src/app.ts",
          compatibility_date: "2026-10-01",
          network: { backend: ["https://api.example.test"] },
        }),
      },
    });

    expect(unknown.status).toBe(422);
    expect(await failure(unknown)).toContain("network");
  });

  it("adds the network origins widefleet.jsonc declares, as widefleet deploy does", async () => {
    const declared = await post("/bundle", {
      files: {
        ...project,
        "widefleet.jsonc": `{
  // Comments and trailing commas, as in wrangler.jsonc.
  "network": { "backend": ["https://api.example.test"], },
}
`,
      },
    });

    expect(declared.status, await declared.clone().text()).toBe(200);
    expect(bundleResult.parse(await declared.json()).metadata.network).toEqual({
      backend: ["https://api.example.test"],
      browser: [],
    });

    const invalid = await post("/bundle", {
      files: {
        ...project,
        "widefleet.jsonc": '{ "network": { "backend": ["http://api.example.test/path"] } }',
      },
    });

    expect(invalid.status).toBe(422);
    expect(await failure(invalid)).toContain("Invalid widefleet.jsonc");
  });

  // As pnpm-workspace.yaml declares them for `pnpm install`.
  const patched = (patches: Record<string, string>, files: Record<string, string> = {}) => ({
    ...project,
    "pnpm-workspace.yaml": `patchedDependencies:\n${Object.entries(patches)
      .map(([dependency, path]) => `  "${dependency}": ${path}\n`)
      .join("")}`,
    ...files,
  });

  const greetingPatch = [
    "diff --git a/index.js b/index.js",
    "index 0000000..1111111 100644",
    "--- a/index.js",
    "+++ b/index.js",
    "@@ -1,2 +1,2 @@",
    "-export const greet = (name) => `Hello ${name}`;",
    "+export const greet = (name) => `Patched hello ${name}`;",
    " //# sourceMappingURL=index.js.map",
    "",
  ].join("\n");

  // Changes a declaration, which bundles do not install, and adds a file.
  const declarationPatch = [
    "diff --git a/index.d.ts b/index.d.ts",
    "--- a/index.d.ts",
    "+++ b/index.d.ts",
    "@@ -1,4 +1,4 @@",
    "-/** A shape to measure. */",
    "+/** A patched shape. */",
    " export interface Shape {",
    "   size: number;",
    " }",
    "diff --git a/added.d.ts b/added.d.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/added.d.ts",
    "@@ -0,0 +1 @@",
    "+export {};",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  it("applies the dependency patches the project declares for pnpm", async () => {
    const files = patched(
      { "greeting@1.0.0": "patches/greeting@1.0.0.patch", "shape-types": "./patches/shape.patch" },
      { "patches/greeting@1.0.0.patch": greetingPatch, "patches/shape.patch": declarationPatch },
    );

    const bundled = await post("/bundle", { files });

    expect(bundled.status, await bundled.clone().text()).toBe(200);
    const result = bundleResult.parse(await bundled.json());

    expect(result.worker).toContain("Patched hello");
    expect(result.worker).not.toContain("`Hello ");

    const documented = await post("/document", {
      files,
      worker: result.worker,
      map: result.map,
      entry: result.entry,
      entrypoints: result.metadata.entrypoints,
    });

    expect(documented.status, await documented.clone().text()).toBe(200);
    const { documentation } = documentResult.parse(await documented.json());

    expect(documentation.types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'import("./node_modules/shape-types/index").Shape',
          summary: "A patched shape.",
        }),
      ]),
    );
  });

  it("keeps type sources a patched manifest names", async () => {
    const manifest = JSON.stringify({ name: "shape-types", version: "2.0.0", types: "index.d.ts" });

    const sourcePatch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1 +1 @@",
      `-${manifest}`,
      "\\ No newline at end of file",
      `+${manifest.replace("index.d.ts", "src/shape.ts")}`,
      "\\ No newline at end of file",
      "diff --git a/src/shape.ts b/src/shape.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/shape.ts",
      "@@ -0,0 +1,4 @@",
      "+/** A shape from its source. */",
      "+export interface Shape {",
      "+  size: number;",
      "+}",
      "",
    ].join("\n");

    const files = patched(
      { "shape-types@2.0.0": "patches/shape.patch" },
      { "patches/shape.patch": sourcePatch },
    );

    const bundled = await post("/bundle", { files });

    expect(bundled.status, await bundled.clone().text()).toBe(200);
    const result = bundleResult.parse(await bundled.json());

    const documented = await post("/document", {
      files,
      worker: result.worker,
      map: result.map,
      entry: result.entry,
      entrypoints: result.metadata.entrypoints,
    });

    expect(documented.status, await documented.clone().text()).toBe(200);
    expect(documentResult.parse(await documented.json()).documentation.types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'import("./node_modules/shape-types/src/shape").Shape',
          summary: "A shape from its source.",
        }),
      ]),
    );
  });

  it("keeps published type sources that only the patched manifest names", async () => {
    const manifest = JSON.stringify({ name: "shape-types", version: "2.0.0", types: "index.d.ts" });

    const manifestPatch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1 +1 @@",
      `-${manifest}`,
      "\\ No newline at end of file",
      `+${manifest.replace("index.d.ts", "src/published.ts")}`,
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const files = patched(
      { "shape-types@2.0.0": "patches/shape.patch" },
      { "patches/shape.patch": manifestPatch },
    );

    const bundled = await post("/bundle", { files });

    expect(bundled.status, await bundled.clone().text()).toBe(200);
    const result = bundleResult.parse(await bundled.json());

    const documented = await post("/document", {
      files,
      worker: result.worker,
      map: result.map,
      entry: result.entry,
      entrypoints: result.metadata.entrypoints,
    });

    expect(documented.status, await documented.clone().text()).toBe(200);
    expect(documentResult.parse(await documented.json()).documentation.types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'import("./node_modules/shape-types/src/published").Shape',
          summary: "A shape from its published source.",
        }),
      ]),
    );
  });

  it("fails builds whose dependency patches do not apply", async () => {
    const context = await post("/bundle", {
      files: patched(
        { "greeting@1.0.0": "patches/greeting.patch" },
        { "patches/greeting.patch": greetingPatch.replace("`Hello ${name}`", "`Hi ${name}`") },
      ),
    });

    expect(context.status).toBe(422);
    expect(await failure(context)).toBe("The patch greeting@1.0.0 does not apply to index.js");

    const version = await post("/bundle", {
      files: patched(
        { "greeting@2.0.0": "patches/greeting.patch" },
        { "patches/greeting.patch": greetingPatch },
      ),
    });

    expect(version.status).toBe(422);
    expect(await failure(version)).toBe(
      "No installed package matches the patched dependency greeting@2.0.0",
    );

    const missing = await post("/bundle", {
      files: patched({ "greeting@1.0.0": "patches/greeting.patch" }),
    });

    expect(missing.status).toBe(422);
    expect(await failure(missing)).toBe("The patch file patches/greeting.patch is missing");
  });
});
