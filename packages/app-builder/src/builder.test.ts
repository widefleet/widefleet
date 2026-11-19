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

const token = "synthetic-builder-token";

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
    "index.js": "export const greet = (name) => `Hello ${name}`;\n",
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

  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(files["package.json"] ?? "{}"));

  return Response.json({
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
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
  "vars": { "GREETING": "hi" },
  "d1_databases": [{ "binding": "DB", "database_name": "accounts" }],
  "triggers": { "crons": ["0 * * * *"] },
}
`,
  "package.json": JSON.stringify({
    name: "fixture",
    private: true,
    dependencies: { greeting: "1.0.0", "runtime-variant": "^1.0.0" },
  }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["src"],
  }),
  "src/app.ts": `import { greet } from "greeting";
import { runtime } from "runtime-variant";

export default {
  /**
   * Greet someone.
   * @param name Who to greet.
   */
  async greet(name: string): Promise<string> {
    return \`\${greet(name)} from \${runtime}\`;
  },
};
`,
};

describe.runIf(process.env["RUN_BUILDER_TESTS"] === "1")("app builder", () => {
  let builder: Miniflare;

  const post = (
    path: string,
    body: z.input<typeof bundleRequest> | z.input<typeof documentRequest>,
    authorization = `Bearer ${token}`,
  ) =>
    builder.dispatchFetch(`https://builder.example.test${path}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
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
              BUILDER_TOKEN: { type: "json", value: token },
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

  it("rejects requests without the builder token", async () => {
    const response = await post("/bundle", { files: project }, "Bearer wrong");
    expect(response.status).toBe(401);
  });

  it("bundles and documents an app as widefleet deploy does", async () => {
    const bundled = await post("/bundle", { files: project });
    expect(bundled.status).toBe(200);
    const result = bundleResult.parse(await bundled.json());

    expect(result.entry).toBe("src/app.ts");
    expect(result.metadata).toMatchObject({
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "plain_text", name: "GREETING", text: "hi" },
        { type: "d1", name: "DB", database_name: "accounts" },
      ],
      web: true,
      entrypoints: ["default"],
      crons: ["0 * * * *"],
      queue_consumers: [],
      debug: { source_maps: { "worker.js": "worker.js.map" } },
    });
    expect(result.metadata.debug?.build_id).toMatch(/^[0-9a-f]{64}$/);
    // nodejs_compat bundles keep built-ins external behind the CLI's require bridge.
    expect(result.worker.startsWith("var require = (specifier) => {")).toBe(true);
    expect(result.worker).toContain("workerd build");
    expect(result.worker).not.toContain("node build");
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
    const { documentation } = documentResult.parse(await documented.json());

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
        ],
      }),
    ]);
    expect(registryRequests).toEqual(expect.arrayContaining(["/greeting", "/runtime-variant"]));
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
      },
    });

    expect(assets.status).toBe(422);
    expect(await failure(assets)).toBe(
      "Projects with static assets are deployed with the Widefleet CLI",
    );

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
  });
});
