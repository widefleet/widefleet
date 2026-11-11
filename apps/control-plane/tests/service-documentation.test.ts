import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { executionWorkerMetadata, serviceDocumentation, workerMetadata } from "@platform/contracts";
import { extractServiceDocumentation } from "../../../tools/service-docs.ts";
import { packageServiceDocumentation } from "../../../tools/service-docs-package.ts";
import { renderServiceDocumentation } from "../src/lib/server/service-documentation.ts";

const execute = promisify(execFile);

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function project(source: string) {
  const root = await mkdtemp(join(tmpdir(), "service documentation "));
  directories.push(root);
  await writeFile(join(root, "app.ts"), source);
  await writeFile(
    join(root, "workers.d.ts"),
    'declare module "cloudflare:workers" { export class WorkerEntrypoint { protected env: object; } }',
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
      },
      include: ["*.ts"],
    }),
  );

  return root;
}

async function bundle(root: string, entry = "app.ts") {
  const file = join(root, "final/worker.js");
  await build({
    entryPoints: [join(root, entry)],
    outfile: file,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    sourcemap: "external",
    external: ["cloudflare:workers"],
  });

  return file;
}

const code = `import {WorkerEntrypoint as Worker} from 'cloudflare:workers';
export interface Query {
  /** Item identifier. */
  id: string;
  limit?: number;
}
class Base extends Worker {
  /** Read one item.
   * @param query - Select the item.
   * @returns The selected item.
   * @remarks Requires a signed-in user.
   * @privateRemarks Do not publish this implementation note.
   * @example
   * \`\`\`ts
   * await api.read({id: "one"});
   * \`\`\`
   */
  read(query: Query) { return {id:query.id}; }
}
/** Inventory service. */
export class Reader extends Base {
  #secret() { return "secret"; }
  arrow = () => "not RPC";
  get value() { return 1; }
  scheduled() {}
  WIDEFLEET_internal() {}
  fetch(request: Request) { return new Response(request.url); }
  /** Old method. @deprecated Use read instead. */
  old() { return 1; }
}
export function helper() { return 1; }
export {Reader as Renamed};
`;

it("documents actual inherited RPC methods, aliases, types and TSDoc without private implementation notes", async () => {
  const root = await project(code);

  const result = extractServiceDocumentation(root, await bundle(root), [
    "Reader",
    "Renamed",
    "helper",
  ]);

  expect(result.warnings).toEqual([]);
  expect(result.documentation.entrypoints.map((entry) => entry.name)).toEqual([
    "Reader",
    "Renamed",
  ]);
  const reader = result.documentation.entrypoints[0];
  expect(reader).toMatchObject({ summary: "Inventory service.", http: true });
  expect(reader?.methods.map((method) => method.name).sort()).toEqual(["old", "read"]);
  expect(reader?.methods.find((method) => method.name === "read")).toMatchObject({
    summary: "Read one item.",
    remarks: "Requires a signed-in user.",
    examples: [expect.stringContaining('await api.read({id: "one"});')],
    signatures: [
      {
        parameters: [
          {
            name: "query",
            type: "Query",
            description: "Select the item.",
            optional: false,
            rest: false,
          },
        ],
        returns: { description: "The selected item." },
      },
    ],
  });
  expect(
    reader?.methods.find((method) => method.name === "read")?.signatures[0]?.returns.type,
  ).toContain("Promise<");
  expect(result.documentation.types.find((type) => type.name === "Query")?.definition).toContain(
    "Item identifier.",
  );
  expect(JSON.stringify(result.documentation)).not.toContain("implementation note");
});

it("recovers original comments and types through a framework build and an export wrapper without configuration", async () => {
  const root = await project(code);
  await build({
    entryPoints: [join(root, "app.ts")],
    outfile: join(root, "build/framework.js"),
    bundle: true,
    minify: true,
    platform: "browser",
    format: "esm",
    sourcemap: true,
    external: ["cloudflare:workers"],
  });
  await writeFile(
    join(root, "wrapper.ts"),
    'export {Reader as default, Renamed} from "./build/framework.js";',
  );
  // The final bundle must describe the code that was built, even if the source
  // file was edited afterwards and deployment uses --skip-build.
  await writeFile(join(root, "app.ts"), code.replace("Read one item.", "STALE COMMENT"));

  const result = extractServiceDocumentation(root, await bundle(root, "wrapper.ts"), [
    "default",
    "Renamed",
  ]);

  expect(result.documentation.entrypoints.map((entry) => entry.name).sort()).toEqual([
    "Renamed",
    "default",
  ]);
  expect(
    result.documentation.entrypoints[0]?.methods.find((method) => method.name === "read")?.summary,
  ).toBe("Read one item.");
  expect(result.documentation.types.some((type) => type.name === "Query")).toBe(true);
});

it("describes object-handler client signatures without injected env and ctx parameters", async () => {
  const root = await project(`export default {
    /** Echo the input. @param input - Text to echo. */
    echo(input: string, env: object, ctx: object) { return input; },
    fetch(request: Request) { return new Response(request.url); }
  };`);

  const result = extractServiceDocumentation(root, await bundle(root), ["default"]);
  expect(result.documentation.entrypoints[0]?.methods[0]?.signatures).toEqual([
    {
      parameters: [
        {
          name: "input",
          type: "string",
          description: "Text to echo.",
          optional: false,
          rest: false,
        },
      ],
      returns: { type: "Promise<string>", description: "" },
    },
  ]);
});

it("resolves Zod input types without requiring an app documentation dependency", async () => {
  const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    import {z} from "zod";
    const input = z.object({query:z.string(),limit:z.number().default(10)});
    export default class extends WorkerEntrypoint {
      /** Search items. */
      search(options: z.input<typeof input>) { return input.parse(options); }
    }`);

  await mkdir(join(root, "node_modules"));
  await symlink(
    dirname(fileURLToPath(import.meta.resolve("zod/package.json"))),
    join(root, "node_modules/zod"),
    "junction",
  );
  const result = extractServiceDocumentation(root, await bundle(root), ["default"]);
  const parameter = result.documentation.entrypoints[0]?.methods[0]?.signatures[0]?.parameters[0];
  expect(parameter?.type).toContain("query: string");
  expect(parameter?.type).toContain("limit?: number");
});

it("includes types nested in containers and distinguishes generic interface instances", async () => {
  const root = await project(`import * as Workers from "cloudflare:workers";
    interface Item { id: string }
    interface Page<T> { items: T[]; cursor?: string }
    export default class extends Workers.WorkerEntrypoint {
      read(input: [string, number?], lookup: Map<string, Item>): Page<Item> { return {items: []}; }
      names(): Page<string> { return {items: []}; }
    }`);

  const result = extractServiceDocumentation(root, await bundle(root), ["default"]);
  expect(result.warnings).toEqual([]);
  expect(result.documentation.types.find((type) => type.name === "Item")?.definition).toContain(
    '"id": string',
  );
  const methods = result.documentation.entrypoints[0]?.methods;
  expect(methods?.find((method) => method.name === "read")?.signatures[0]?.returns.type).toContain(
    "Array<Item>",
  );
  expect(methods?.find((method) => method.name === "names")?.signatures[0]?.returns.type).toContain(
    "Array<string>",
  );
  expect(
    methods?.find((method) => method.name === "read")?.signatures[0]?.parameters[1]?.type,
  ).toBe("Map<string, Item>");
});

it("ships a self-contained helper and declaration libraries in the CLI installation", async () => {
  const root = await project(code);
  const file = await bundle(root);
  const installation = join(root, "installation");
  await packageServiceDocumentation(installation);

  const result = await execute(process.execPath, [
    join(installation, "service-docs/extract.cjs"),
    root,
    file,
    "Reader",
  ]);

  const docs = serviceDocumentation.parse(JSON.parse(result.stdout));
  expect(docs.entrypoints[0]?.methods.some((method) => method.name === "read")).toBe(true);
  expect(await readFile(join(installation, "service-docs/lib.es2022.d.ts"), "utf8")).toContain(
    "reference",
  );
  expect(
    await readFile(join(installation, "service-docs/licenses/tsdoc-LICENSE"), "utf8"),
  ).toContain("MIT License");
});

it("rejects oversized and mismatched artifact documentation and renders authored HTML as text", () => {
  const docs = {
    format: 1,
    entrypoints: [
      {
        name: "Reader",
        summary: "<script>alert(1)</script>",
        remarks: "",
        examples: [],
        http: false,
        methods: [],
      },
    ],
    types: [],
  };

  expect(
    workerMetadata.safeParse({
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      entrypoints: ["Other"],
      service_documentation: docs,
      assets: { upload_session: crypto.randomUUID() },
    }).success,
  ).toBe(false);
  expect(
    serviceDocumentation.safeParse({
      ...docs,
      types: [
        { name: "Huge", definition: "x".repeat(32769), summary: "", remarks: "", examples: [] },
      ],
    }).success,
  ).toBe(false);
  expect(renderServiceDocumentation(serviceDocumentation.parse(docs))).not.toContain("<script>");

  const metadata = workerMetadata.parse({
    main_module: "worker.js",
    compatibility_date: "2026-10-01",
    entrypoints: ["Reader"],
    service_documentation: docs,
    assets: { upload_session: crypto.randomUUID() },
  });

  expect(executionWorkerMetadata(metadata)).not.toHaveProperty("service_documentation");
  expect(metadata.service_documentation).toEqual(docs);
});
