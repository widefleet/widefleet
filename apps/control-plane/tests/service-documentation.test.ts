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

it("limits documented overloads without rejecting the app", async () => {
  const signatures = Array.from(
    { length: 17 },
    (_, index) => `read(input: ${index}): ${index};`,
  ).join("\n");

  const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    export class Reader extends WorkerEntrypoint {
      ${signatures}
      read(input: number) { return input; }
    }`);

  const result = extractServiceDocumentation(root, await bundle(root), ["Reader"]);
  expect(result.documentation.entrypoints[0]?.methods[0]?.signatures).toHaveLength(16);
  expect(result.warnings).toContain(
    "Only the first 16 overloads of Reader.read are documented; the remaining overloads are still callable.",
  );
});

it.each([
  { summary: "x".repeat(32769), count: 1 },
  { summary: "é".repeat(10000), count: 14 },
  { summary: "Read a value.", count: 129 },
])(
  "omits oversized documentation with a warning while keeping extraction successful ($count methods)",
  async ({ summary, count }) => {
    const methods = Array.from(
      { length: count },
      (_, index) => `/** ${summary} */ read${index}() { return 1; }`,
    ).join("\n");

    const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
      export class Reader extends WorkerEntrypoint {\n${methods}\n}`);

    const result = extractServiceDocumentation(root, await bundle(root), ["Reader"]);
    expect(result.documentation).toEqual({ format: 1, entrypoints: [], types: [] });
    expect(result.warnings).toContainEqual(
      expect.stringContaining("API documentation was omitted because it exceeds supported limits:"),
    );
  },
);

it("handles heavily shared types in the packaged helper without repeatedly expanding each branch", async () => {
  const graph = Array.from(
    { length: 16 },
    (_, index) =>
      `interface Model${index} { left: Model${index + 1}; middle: Model${index + 1}; right: Model${index + 1}; }`,
  ).join("\n");

  const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    ${graph}
    interface Model16 { value: string }
    export class Reader extends WorkerEntrypoint { read(input: Model0) { return input; } }`);

  const file = await bundle(root);
  const installation = join(root, "installation");
  await packageServiceDocumentation(installation);

  // A subprocess deadline also stops a synchronous regression in the compiler walk.
  const result = await execute(
    process.execPath,
    [join(installation, "service-docs/extract.cjs"), root, file, "Reader"],
    { timeout: 10000 },
  );

  const docs = serviceDocumentation.parse(JSON.parse(result.stdout));
  expect(result.stderr).toBe("");
  expect(docs.types).toHaveLength(17);
  expect(docs.types.find((type) => type.name === "Model0")?.definition).toBe(
    'type Model0 = { "left": Model1; "middle": Model1; "right": Model1; };',
  );
  expect(docs.entrypoints[0]?.methods[0]?.signatures[0]?.returns.type).toBe("Promise<Model0>");
});

it("keeps name-conflict diagnostics when completed types are reused", async () => {
  const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    namespace One { export interface Item { id: string } }
    namespace Two { export interface Item { count: number } }
    export class Reader extends WorkerEntrypoint {
      first(input: One.Item) { return input; }
      second(input: Two.Item) { return input; }
      repeated(input: One.Item) { return input; }
    }`);

  const result = extractServiceDocumentation(root, await bundle(root), ["Reader"]);
  expect(result.documentation.types).toHaveLength(1);
  expect(result.documentation.types[0]?.definition).toContain('"id": string');
  expect(result.warnings).toContain(
    "Conflicting API type name Item is shown as unknown. Give public types distinct names.",
  );
  expect(
    result.documentation.entrypoints[0]?.methods.find((method) => method.name === "second")
      ?.signatures[0]?.returns.type,
  ).toBe("Promise<unknown>");
  expect(
    result.documentation.entrypoints[0]?.methods.find((method) => method.name === "repeated")
      ?.signatures[0]?.returns.type,
  ).toBe("Promise<Item>");
});

it.each([false, true])(
  "preserves both mutually recursive generic inputs regardless of method order (reversed: %s)",
  async (reversed) => {
    const methods = [
      "readA(input: A<string>) { return input; }",
      "readB(input: B<string>) { return input; }",
    ];

    const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
      interface A<T> { a: T; next: B<T> }
      interface B<T> { b: T; next: A<T> }
      export class Reader extends WorkerEntrypoint {
        ${(reversed ? methods.toReversed() : methods).join("\n")}
      }`);

    const result = extractServiceDocumentation(root, await bundle(root), ["Reader"]);
    expect(result.warnings).toEqual([]);

    for (const [method, type] of [
      ["readA", '{ "a": string; "next": { "b": string; "next": unknown; }; }'],
      ["readB", '{ "b": string; "next": { "a": string; "next": unknown; }; }'],
    ])
      expect(
        result.documentation.entrypoints[0]?.methods.find((item) => item.name === method),
      ).toMatchObject({
        signatures: [{ parameters: [{ type }], returns: { type: `Promise<${type}>` } }],
      });
  },
);

it.each([false, true])(
  "recovers a named type first encountered near the depth limit (reversed: %s)",
  async (reversed) => {
    const graph = Array.from(
      { length: 20 },
      (_, index) => `interface Model${index} { next: Model${index + 1} }`,
    ).join("\n");

    const methods = [
      "deep(input: Model0) { return input; }",
      "direct(input: Model20) { return input; }",
    ];

    const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
      ${graph}
      interface Model20 { value: string }
      export class Reader extends WorkerEntrypoint {
        ${(reversed ? methods.toReversed() : methods).join("\n")}
      }`);

    const result = extractServiceDocumentation(root, await bundle(root), ["Reader"]);
    expect(result.documentation.types.find((type) => type.name === "Model20")?.definition).toBe(
      'type Model20 = { "value": string; };',
    );
    expect(result.warnings.some((warning) => warning.includes("Conflicting API type name"))).toBe(
      false,
    );
    expect(
      result.documentation.entrypoints[0]?.methods.find((method) => method.name === "direct"),
    ).toMatchObject({
      signatures: [{ parameters: [{ type: "Model20" }], returns: { type: "Promise<Model20>" } }],
    });
  },
);

it("renders replacement advice and examples on referenced types", () => {
  const docs = serviceDocumentation.parse({
    format: 1,
    entrypoints: [],
    types: [
      {
        name: "Query",
        definition: "type Query = { id: string };",
        summary: "Select one item.",
        remarks: "Identifiers are case-sensitive.",
        deprecated: "Use ItemQuery for new integrations.",
        examples: ['```ts\nconst query: Query = { id: "one" };\n```'],
      },
    ],
  });

  const html = renderServiceDocumentation(docs);
  expect(html).toContain("Deprecated: Use ItemQuery for new integrations.");
  expect(html).toContain("<strong>Example</strong>");
  expect(html).toContain("const query: Query = { id: &quot;one&quot; };");
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
