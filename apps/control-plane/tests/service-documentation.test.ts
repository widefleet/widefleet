import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { executionWorkerMetadata, serviceDocumentation, workerMetadata } from "@platform/contracts";
import { extractServiceDocumentation } from "./service-documentation-fixture.ts";
import { renderServiceDocumentation } from "../src/lib/server/service-documentation.ts";

const native = it.runIf(process.env["RUN_CLI_TESTS"] === "1");

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
    sourcemap: true,
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

native(
  "documents actual inherited RPC methods, aliases, types and TSDoc without private implementation notes",
  async () => {
    const root = await project(code);

    const result = await extractServiceDocumentation(root, await bundle(root), [
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
              type: 'import("./app").Query',
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
    expect(
      result.documentation.types.find((type) => type.name === 'import("./app").Query')?.definition,
    ).toContain("Item identifier.");
    expect(JSON.stringify(result.documentation)).not.toContain("implementation note");
  },
);

native(
  "recovers original comments and types through a framework build and an export wrapper without configuration",
  async () => {
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

    const result = await extractServiceDocumentation(root, await bundle(root, "wrapper.ts"), [
      "default",
      "Renamed",
    ]);

    expect(result.documentation.entrypoints.map((entry) => entry.name).sort()).toEqual([
      "Renamed",
      "default",
    ]);
    expect(
      result.documentation.entrypoints[0]?.methods.find((method) => method.name === "read")
        ?.summary,
    ).toBe("Read one item.");
    expect(result.documentation.types.some((type) => type.name === 'import("./app").Query')).toBe(
      true,
    );
  },
);

native(
  "describes object-handler client signatures without injected env and ctx parameters",
  async () => {
    const root = await project(`export default {
    /** Echo the input. @param input - Text to echo. */
    echo(input: string, env: object, ctx: object) { return input; },
    fetch(request: Request) { return new Response(request.url); }
  };`);

    const result = await extractServiceDocumentation(root, await bundle(root), ["default"]);
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
  },
);

native("resolves Zod input types without requiring an app documentation dependency", async () => {
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
  const result = await extractServiceDocumentation(root, await bundle(root), ["default"]);
  const parameter = result.documentation.entrypoints[0]?.methods[0]?.signatures[0]?.parameters[0];
  expect(parameter?.type).toContain("query: string");
  expect(parameter?.type).toContain("limit?: number");
});

native(
  "includes types nested in containers and distinguishes generic interface instances",
  async () => {
    const root = await project(`import * as Workers from "cloudflare:workers";
    interface Item { id: string }
    interface Page<T> { items: T[]; cursor?: string }
    export default class extends Workers.WorkerEntrypoint {
      read(input: [string, number?], lookup: Map<string, Item>): Page<Item> { return {items: []}; }
      names(): Page<string> { return {items: []}; }
    }`);

    const result = await extractServiceDocumentation(root, await bundle(root), ["default"]);
    expect(result.warnings).toEqual([]);
    expect(result.documentation.types.find((type) => type.name === "Item")?.definition).toContain(
      "id: string",
    );
    const methods = result.documentation.entrypoints[0]?.methods;
    expect(methods?.find((method) => method.name === "read")?.signatures[0]?.returns.type).toBe(
      "Promise<Page<Item>>",
    );
    expect(
      result.documentation.types.find((type) => type.name === "Page<Item>")?.definition,
    ).toContain("items: Item[]");
    expect(methods?.find((method) => method.name === "names")?.signatures[0]?.returns.type).toBe(
      "Promise<Page<string>>",
    );
    expect(
      result.documentation.types.find((type) => type.name === "Page<string>")?.definition,
    ).toContain("items: string[]");
    expect(
      methods?.find((method) => method.name === "read")?.signatures[0]?.parameters[1]?.type,
    ).toBe("Map<string, Item>");
  },
);

native("limits documented overloads without rejecting the app", async () => {
  const signatures = Array.from(
    { length: 17 },
    (_, index) => `read(input: ${index}): ${index};`,
  ).join("\n");

  const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    export class Reader extends WorkerEntrypoint {
      ${signatures}
      read(input: number) { return input; }
    }`);

  const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
  expect(result.documentation.entrypoints[0]?.methods[0]?.signatures).toHaveLength(16);
  expect(result.warnings).toContain(
    "Only the first 16 overloads of Reader.read are documented; the remaining overloads are still callable.",
  );
});

native.each([
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

    const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
    expect(result.documentation).toEqual({ format: 1, entrypoints: [], types: [] });
    expect(result.warnings).toContainEqual(
      expect.stringContaining("API documentation was omitted because it exceeds supported limits"),
    );
  },
);

native(
  "documents heavily shared types once without recursively expanding each branch",
  async () => {
    const graph = Array.from(
      { length: 16 },
      (_, index) =>
        `interface Model${index} { left: Model${index + 1}; middle: Model${index + 1}; right: Model${index + 1}; }`,
    ).join("\n");

    const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    ${graph}
    interface Model16 { value: string }
    export class Reader extends WorkerEntrypoint { read(input: Model0) { return input; } }`);

    const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
    const docs = result.documentation;
    expect(result.warnings).toEqual([]);
    expect(docs.types).toHaveLength(17);

    for (const name of ["left", "middle", "right"])
      expect(docs.types.find((type) => type.name === "Model0")?.definition).toContain(
        `${name}: Model1`,
      );
    expect(docs.entrypoints[0]?.methods[0]?.signatures[0]?.returns.type).toBe("Promise<Model0>");
  },
);

native("qualifies conflicting names without discarding either type", async () => {
  const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    namespace One { export interface Item { id: string } }
    namespace Two { export interface Item { count: number } }
    export class Reader extends WorkerEntrypoint {
      first(input: One.Item) { return input; }
      second(input: Two.Item) { return input; }
      repeated(input: One.Item) { return input; }
    }`);

  const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
  expect(result.warnings).toEqual([]);
  expect(result.documentation.types).toHaveLength(2);
  expect(result.documentation.types.find((type) => type.name === "One.Item")?.definition).toContain(
    "id: string",
  );
  expect(result.documentation.types.find((type) => type.name === "Two.Item")?.definition).toContain(
    "count: number",
  );

  for (const [method, type] of [
    ["first", "One.Item"],
    ["second", "Two.Item"],
    ["repeated", "One.Item"],
  ])
    expect(
      result.documentation.entrypoints[0]?.methods.find((item) => item.name === method)
        ?.signatures[0]?.returns.type,
    ).toBe(`Promise<${type}>`);
});

native.each([false, true])(
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

    const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
    expect(result.warnings).toEqual([]);
    expect(
      result.documentation.types.find((type) => type.name === "A<string>")?.definition,
    ).toMatch(/a: string;[\s\S]*next: B<string>/);
    expect(
      result.documentation.types.find((type) => type.name === "B<string>")?.definition,
    ).toMatch(/b: string;[\s\S]*next: A<string>/);

    for (const [method, type] of [
      ["readA", "A<string>"],
      ["readB", "B<string>"],
    ])
      expect(
        result.documentation.entrypoints[0]?.methods.find((item) => item.name === method),
      ).toMatchObject({
        signatures: [{ parameters: [{ type }], returns: { type: `Promise<${type}>` } }],
      });
  },
);

native.each([
  { reversed: false, recursive: false },
  { reversed: true, recursive: false },
  { reversed: false, recursive: true },
  { reversed: true, recursive: true },
])(
  "preserves deep references and complete named types (reversed: $reversed, recursive: $recursive)",
  async ({ reversed, recursive }) => {
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
      interface Loop<T> { value: T; next: Loop<T> }
      interface Model20 { value: string; ${recursive ? "loop: Loop<string>" : ""} }
      export class Reader extends WorkerEntrypoint {
        ${(reversed ? methods.toReversed() : methods).join("\n")}
      }`);

    const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);

    const definition = result.documentation.types.find(
      (type) => type.name === "Model20",
    )?.definition;

    expect(definition).toContain("value: string");
    expect(definition).not.toContain("unknown");

    if (recursive) {
      expect(definition).toContain("loop: Loop<string>");
      expect(
        result.documentation.types.find((type) => type.name === "Loop<string>")?.definition,
      ).toMatch(/value: string;[\s\S]*next: Loop<string>/);
    }

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

native(
  "resolves imported types through project aliases with partial compiler options",
  async () => {
    const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    import type {Item} from "@model";
    export class Reader extends WorkerEntrypoint { read(input: Map<string, Item>) { return input; } }`);

    await writeFile(join(root, "model.ts"), "export interface Item { id: string }");
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@model": ["./model.ts"] } },
        include: ["*.ts"],
      }),
    );
    const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
    expect(result.documentation.entrypoints[0]?.methods[0]?.signatures[0]?.returns.type).toBe(
      'Promise<Map<string, import("./model").Item>>',
    );
    expect(
      result.documentation.types.find((type) => type.name === 'import("./model").Item')?.definition,
    ).toContain("id: string");
  },
);

native("collects alias, dictionary and callback types from declaration files", async () => {
  const root = await project(`import { WorkerEntrypoint } from "cloudflare:workers";
    import type { Item, Choice } from "./model";
    interface Input { dictionary: { [key: string]: Item }; callback: () => Item; choice: Choice }
    export class Reader extends WorkerEntrypoint { read(input: Input) { return input; } }`);

  await writeFile(
    join(root, "model.d.ts"),
    `
    /** One result. @deprecated Use NewItem. @example const item = {id: "one"}; */
    export interface Item { id: string }
    export type Choice = "one" | "two";
  `,
  );
  const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
  expect(result.warnings).toEqual([]);
  expect(
    result.documentation.types.find((type) => type.name === 'import("./model").Item'),
  ).toMatchObject({
    summary: "One result.",
    deprecated: "Use NewItem.",
    examples: ['const item = {id: "one"};'],
  });
  expect(
    result.documentation.types.find((type) => type.name === 'import("./model").Item')?.definition,
  ).toContain("id: string");
  expect(
    result.documentation.types.find((type) => type.name === 'import("./model").Choice')?.definition,
  ).toContain('"one" | "two"');
  expect(JSON.stringify(result.documentation)).not.toContain(root);
});

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
