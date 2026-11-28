import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  executionWorkerMetadata,
  selectServiceMethods,
  serviceDescriptionBudget,
  serviceDocumentation,
  shortenTypeNames,
  workerMetadata,
} from "@platform/contracts";
import { extractServiceDocumentation } from "./service-documentation-fixture.ts";
import { presentServiceDocumentation } from "../src/lib/server/service-documentation.ts";

const native = it.runIf(process.env["RUN_CLI_TESTS"] === "1");

const directories: string[] = [];

afterEach(async () => {
  // Concurrent removal of a nested fixture and its parent races on Windows.
  for (const directory of directories.splice(0).reverse())
    await rm(directory, { recursive: true, force: true });
});

async function project(source: string, parent = tmpdir()) {
  // Match the CLI's canonical build directory. On macOS, tmpdir() uses /var
  // through a symlink; esbuild's relative source maps otherwise change meaning
  // when the CLI rebundles the same files through /private/var.
  const root = await realpath(await mkdtemp(join(parent, "service documentation ")));
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
    // file was edited afterwards; the project has no build script that rebuilds it.
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
    const root = await project(`interface InternalEnv { secret: string }
    export default {
    /** Echo the input. @param input - Text to echo. */
    echo(input: string, env: InternalEnv, ctx: object) { return input; },
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
        uses: [],
      },
    ]);
    // Injected parameters are not part of the client's API, nor are their types.
    expect(result.documentation.types).toEqual([]);
  },
);

native("keeps the TSDoc comment of an HTTP-only default object handler", async () => {
  const root = await project(`/** Export orders as CSV over HTTP. */
  export default {
    fetch(request: Request) { return new Response(request.url); }
  };`);

  const result = await extractServiceDocumentation(root, await bundle(root), ["default"]);
  expect(result.documentation.entrypoints).toMatchObject([
    { name: "default", summary: "Export orders as CSV over HTTP.", http: true, methods: [] },
  ]);
});

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
  "includes types nested in containers and documents a generic interface once with its type parameters",
  async () => {
    const root = await project(`import * as Workers from "cloudflare:workers";
    interface Item { id: string }
    interface Page<T extends Item | string = Item> { items: T[]; cursor?: string }
    export default class extends Workers.WorkerEntrypoint {
      read(input: [string, number?], lookup: Map<string, Item>): Page<Item> { return {items: []}; }
      names(): Page<string> { return {items: []}; }
    }`);

    const result = await extractServiceDocumentation(root, await bundle(root), ["default"]);
    expect(result.warnings).toEqual([]);
    const item = result.documentation.types.find((type) => type.name === "Item");
    expect(item?.kind).toBe("interface");
    expect(item?.definition).toContain("id: string");
    const methods = result.documentation.entrypoints[0]?.methods;
    expect(methods?.find((method) => method.name === "read")?.signatures[0]?.returns.type).toBe(
      "Promise<Page<Item>>",
    );
    expect(methods?.find((method) => method.name === "names")?.signatures[0]?.returns.type).toBe(
      "Promise<Page<string>>",
    );
    expect(result.documentation.types.map((type) => type.name).toSorted()).toEqual([
      "Item",
      "Page<T>",
    ]);
    const page = result.documentation.types.find((type) => type.name === "Page<T>");
    expect(page?.kind).toBe("interface");
    expect(page?.definition).toContain("items: T[]");
    expect(page?.typeParameters).toEqual(["T extends string | Item = Item"]);
    expect(page?.uses).toEqual(["Item"]);
    expect(
      methods?.find((method) => method.name === "read")?.signatures[0]?.parameters[1]?.type,
    ).toBe("Map<string, Item>");
    expect(
      selectServiceMethods(result.documentation, "default", {
        methods: ["read"],
        types: [],
      }).selection?.types.map((type) => type.name),
    ).toEqual(expect.arrayContaining(["Item", "Page<T>"]));
    expect(
      selectServiceMethods(result.documentation, "default", {
        methods: ["names"],
        types: [],
      }).selection?.types.map((type) => type.name),
    ).toEqual(["Item", "Page<T>"]);
  },
);

native("keeps the names of aliases an alias refers to", async () => {
  const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    type Comparator = { eq?: string; in?: string[] };
    type Filter = { title?: Comparator | null; and?: Filter[] };
    export class Reader extends WorkerEntrypoint {
      find(filter: Filter) { return filter; }
    }`);

  const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
  expect(result.warnings).toEqual([]);
  const filter = result.documentation.types.find((type) => type.name === "Filter");
  expect(filter?.definition).toContain("title?: Comparator | null");
  expect(filter?.definition).not.toContain("eq?: string");
  expect(filter?.uses).toEqual(["Comparator"]);
  expect(
    result.documentation.types.find((type) => type.name === "Comparator")?.definition,
  ).toContain("eq?: string");
});

native("documents generic type aliases with their own structure", async () => {
  const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    interface Role { name: string }
    type Tree<T> = { value: T; children: Tree<T>[] };
    export class Reader extends WorkerEntrypoint {
      tree(): Tree<number> { return {value: 1, children: []}; }
      role(): Role | null { return null; }
    }`);

  const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
  expect(result.warnings).toEqual([]);
  const tree = result.documentation.types.find((type) => type.name === "Tree<T>");
  expect(tree?.kind).toBe("type");
  expect(tree?.definition).toMatch(/value: T;[\s\S]*children: Tree<T>\[\]/);
  // The alias inside a nullable union stays a documented reference.
  expect(
    selectServiceMethods(result.documentation, "Reader", {
      methods: ["role"],
      types: [],
    }).selection?.types.map((type) => type.name),
  ).toEqual(["Role"]);
});

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
  { summary: "x".repeat(262145), count: 1 },
  { summary: "Read a value.", count: 1025 },
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
    expect(result.documentation).toEqual({ format: 3, entrypoints: [], types: [] });
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

native("records types named only by a nested signature's type parameters", async () => {
  const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    interface Item { id: string }
    interface Callback { <T extends Item = Item>(value: T): void }
    export class Reader extends WorkerEntrypoint {
      subscribe(callback: Callback) { return true; }
    }`);

  const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
  expect(result.warnings).toEqual([]);
  expect(
    selectServiceMethods(result.documentation, "Reader", {
      methods: ["subscribe"],
      types: [],
    }).selection?.types.map((type) => type.name),
  ).toEqual(expect.arrayContaining(["Callback", "Item"]));
});

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
  ] as const) {
    expect(
      result.documentation.entrypoints[0]?.methods.find((item) => item.name === method)
        ?.signatures[0]?.returns.type,
    ).toBe(`Promise<${type}>`);
    expect(
      selectServiceMethods(result.documentation, "Reader", {
        methods: [method],
        types: [],
      }).selection?.types.map((entry) => entry.name),
    ).toEqual([type]);
  }
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
    expect(result.documentation.types.find((type) => type.name === "A<T>")?.definition).toMatch(
      /a: T;[\s\S]*next: B<T>/,
    );
    expect(result.documentation.types.find((type) => type.name === "B<T>")?.definition).toMatch(
      /b: T;[\s\S]*next: A<T>/,
    );

    for (const [method, type] of [
      ["readA", "A<string>"],
      ["readB", "B<string>"],
    ])
      expect(
        result.documentation.entrypoints[0]?.methods.find((item) => item.name === method),
      ).toMatchObject({
        signatures: [{ parameters: [{ type }], returns: { type: `Promise<${type}>` } }],
      });

    for (const method of ["readA", "readB"])
      expect(
        selectServiceMethods(result.documentation, "Reader", { methods: [method], types: [] })
          .selection?.types.map((type) => type.name)
          .toSorted(),
      ).toEqual(["A<T>", "B<T>"]);
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
        result.documentation.types.find((type) => type.name === "Loop<T>")?.definition,
      ).toMatch(/value: T;[\s\S]*next: Loop<T>/);
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

native("keeps sibling workspace types distinct without publishing absolute paths", async () => {
  const workspace = await project("");
  await Promise.all(
    ["shared", "other"].map(async (name) => {
      await mkdir(join(workspace, name));
      await writeFile(
        join(workspace, name, "model.ts"),
        `export interface Item { ${name === "shared" ? "id: string" : "count: number"} }`,
      );
    }),
  );

  const root = await project(
    `import {WorkerEntrypoint} from "cloudflare:workers";
      import type {Item} from "../shared/model";
      import type {Item as Other} from "../other/model";
      export interface Input { item: Item; other: Other }
      export class Reader extends WorkerEntrypoint {
        read<T extends Item = Item>(input: T): T { return input; }
        combine(input: Input): Other { return input.other; }
      }`,
    workspace,
  );

  const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
  expect(result.warnings).toEqual([]);
  const methods = result.documentation.entrypoints[0]?.methods;
  expect(methods?.find((method) => method.name === "read")?.signatures[0]).toMatchObject({
    typeParameters: ['T extends import("../shared/model").Item = import("../shared/model").Item'],
    parameters: [{ type: "T" }],
    returns: { type: "Promise<T>" },
  });
  expect(methods?.find((method) => method.name === "combine")?.signatures[0]?.returns.type).toBe(
    'Promise<import("../other/model").Item>',
  );
  expect(
    result.documentation.types.find((type) => type.name === 'import("../shared/model").Item')
      ?.definition,
  ).toContain("id: string");
  expect(
    result.documentation.types.find((type) => type.name === 'import("../other/model").Item')
      ?.definition,
  ).toContain("count: number");
  const input = result.documentation.types.find((type) => type.name === 'import("./app").Input');
  expect(input?.definition).toContain('import("../shared/model").Item');
  expect(input?.definition).toContain('import("../other/model").Item');
  expect(JSON.stringify(result.documentation)).not.toContain(workspace.replaceAll("\\", "/"));
});

native(
  "preserves generic declarations, constraints and defaults on each method signature",
  async () => {
    const root = await project(`import {WorkerEntrypoint} from "cloudflare:workers";
    interface Item { id: string }
    export class Reader extends WorkerEntrypoint {
      read<T extends { id: string }>(input: T): T { return input; }
      list<T extends Item = Item>(input: T[]): T[] { return input; }
      pick<T extends Item, K extends keyof T>(input: T, key: K): T[K] { return input[key]; }
      echo<T>(input: T): T { return input; }
      literal<const T extends string>(input: T): T { return input; }
      overloaded<T extends Item>(input: T): T;
      overloaded<T extends { count: number }>(input: T[]): T[];
      overloaded(input: unknown) { return input; }
    }`);

    const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
    expect(result.warnings).toEqual([]);
    const methods = result.documentation.entrypoints[0]?.methods;
    expect(methods?.find((method) => method.name === "read")).toMatchObject({
      signatures: [
        {
          typeParameters: ["T extends { id: string; }"],
          parameters: [{ type: "T" }],
          returns: { type: "Promise<T>" },
        },
      ],
    });
    expect(methods?.find((method) => method.name === "list")).toMatchObject({
      signatures: [
        {
          typeParameters: ["T extends Item = Item"],
          parameters: [{ type: "T[]" }],
          returns: { type: "Promise<T[]>" },
        },
      ],
    });
    expect(methods?.find((method) => method.name === "pick")).toMatchObject({
      signatures: [
        {
          typeParameters: ["T extends Item", "K extends keyof T"],
          parameters: [{ type: "T" }, { type: "K" }],
          returns: { type: "Promise<Awaited<T[K]>>" },
        },
      ],
    });
    expect(methods?.find((method) => method.name === "echo")).toMatchObject({
      signatures: [{ typeParameters: ["T"] }],
    });
    expect(methods?.find((method) => method.name === "literal")).toMatchObject({
      signatures: [{ typeParameters: ["const T extends string"] }],
    });
    expect(methods?.find((method) => method.name === "overloaded")).toMatchObject({
      signatures: [
        { typeParameters: ["T extends Item"] },
        { typeParameters: ["T extends { count: number; }"] },
      ],
    });
    expect(result.documentation.types.find((type) => type.name === "Item")?.definition).toContain(
      "id: string",
    );
    expect(
      presentServiceDocumentation(result.documentation)
        .entrypoints.flatMap((entry) => entry.methods)
        .find((method) => method.name === "read")?.signatures[0]?.code,
    ).toBe("read<T extends { id: string; }>(input: T): Promise<T>");
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
  ).toBe('"one" | "two"');
  expect(JSON.stringify(result.documentation)).not.toContain(root);
});

native(
  "omits built-in member comments while retaining authored and inherited members",
  async () => {
    const root = await project(`import { WorkerEntrypoint } from "cloudflare:workers";
    import type { Items, Label } from "./model";
    export type Rank = 1 | 2;
    export type Pair = [Label, Rank];
    export type List = Label[];
    export class Reader extends WorkerEntrypoint {
      read(items: Items, pair: Pair, list: List) { return items; }
    }`);

    await writeFile(
      join(root, "model.d.ts"),
      `export interface Details {
      /** Stable identifier. */
      id: string;
    }
    export interface Named {
      /** Display name. */
      name: string;
    }
    export interface Items extends Array<Label>, Named {
      /** Collection metadata. */ details: Details;
    }
    export type Label = string & {
      /** Label brand. */
      readonly brand: "label";
    };`,
    );

    const result = await extractServiceDocumentation(root, await bundle(root), ["Reader"]);
    expect(result.warnings).toEqual([]);

    const definitions = new Map(
      result.documentation.types.map((type) => [type.name, type.definition]),
    );

    expect(definitions.get('import("./app").Rank')).toBe("1 | 2");

    for (const name of ['import("./app").Pair', 'import("./app").List']) {
      expect(definitions.get(name)).toEqual(expect.any(String));
      expect(definitions.get(name)).not.toContain("/**");
    }

    expect(definitions.get('import("./model").Items')).toContain(
      "/** details: Collection metadata. */",
    );
    expect(definitions.get('import("./model").Items')).toContain("/** name: Display name. */");
    expect(definitions.get('import("./model").Details')).toContain("/** id: Stable identifier. */");
    expect(definitions.get('import("./model").Label')).toContain("/** brand: Label brand. */");

    for (const definition of definitions.values()) {
      expect(definition).not.toMatch(/\/\*\* (?:toString|charAt|toFixed|map|push|length):/);
    }
  },
);

it("selects the types a method uses by following recorded uses", () => {
  const type = (name: string, uses: string[] = [], definition = `interface ${name} {}`) => ({
    name,
    kind: "interface",
    definition,
    summary: "",
    remarks: "",
    examples: [],
    uses,
  });

  const method = (name: string, uses: string[]) => ({
    name,
    summary: "",
    remarks: "",
    examples: [],
    throws: [],
    signatures: [{ parameters: [], returns: { type: "Promise<void>", description: "" }, uses }],
  });

  const documentation = serviceDocumentation.parse({
    format: 3,
    entrypoints: [
      {
        name: "Reader",
        summary: "",
        remarks: "",
        examples: [],
        http: false,
        methods: [method("first", ["One.Item", "Page<Item>"]), method("other", ["Unused"])],
      },
    ],
    types: [
      type("One.Item"),
      type("Page<Item>", ["Item"]),
      // Types that use each other are each included once.
      type("Item", ["Owner"]),
      type("Owner", ["Item"]),
      type("One.ItemDetails"),
      type("Unused"),
    ],
  });

  expect(
    selectServiceMethods(documentation, "Reader", { methods: ["first"], types: [] }).selection,
  ).toMatchObject({ omittedTypes: [] });
  expect(
    selectServiceMethods(documentation, "Reader", {
      methods: ["first"],
      types: [],
    }).selection?.types.map((entry) => entry.name),
  ).toEqual(["One.Item", "Page<Item>", "Item", "Owner"]);
  expect(
    selectServiceMethods(documentation, "Reader", {
      methods: [],
      types: ["Item"],
    }).selection?.types.map((entry) => entry.name),
  ).toEqual(["Item", "Owner"]);
  expect(
    selectServiceMethods(documentation, "Reader", {
      methods: ["first", "missing"],
      types: ["Gone"],
    }),
  ).toEqual({
    unknown: { entrypoint: false, methods: ["missing"], types: ["Gone"] },
    selection: null,
  });
  expect(selectServiceMethods(documentation, "Writer", { methods: [], types: ["Item"] })).toEqual({
    unknown: { entrypoint: true, methods: [], types: [] },
    selection: null,
  });
});

it("includes the types a selection names and further types within the budget", () => {
  const type = (name: string, bytes: number, uses: string[] = []) => ({
    name,
    kind: "type",
    definition: "x".repeat(bytes),
    summary: "",
    remarks: "",
    examples: [],
    uses,
  });

  const documentation = serviceDocumentation.parse({
    format: 3,
    entrypoints: [
      {
        name: "Reader",
        summary: "",
        remarks: "",
        examples: [],
        http: false,
        methods: [
          {
            name: "read",
            summary: "",
            remarks: "",
            examples: [],
            throws: [],
            signatures: [
              {
                parameters: [],
                returns: { type: "Promise<Large>", description: "" },
                uses: ["Large", "Small"],
              },
            ],
          },
        ],
      },
    ],
    types: [
      // Named directly by the signature, so always included.
      type("Large", serviceDescriptionBudget - 1500, ["Big", "Near"]),
      type("Small", 100, ["Tiny"]),
      // Reached through other types: Big does not fit, the smaller ones do.
      type("Big", 1000, ["Hidden"]),
      type("Near", 10),
      type("Tiny", 10),
      type("Hidden", 10),
    ],
  });

  const selection = (types: string[]) =>
    selectServiceMethods(documentation, "Reader", { methods: types.length ? [] : ["read"], types })
      .selection;

  expect(selection([])?.types.map((entry) => entry.name)).toEqual([
    "Large",
    "Small",
    "Near",
    "Tiny",
  ]);
  expect(selection([])?.omittedTypes).toEqual(["Big"]);
  // An omitted type is described by name with the types it leads to.
  expect(selection(["Big", "Tiny"])?.types.map((entry) => entry.name)).toEqual([
    "Big",
    "Tiny",
    "Hidden",
  ]);
  expect(selection(["Big", "Tiny"])?.omittedTypes).toEqual([]);
});

it("renders replacement advice, examples and short names of referenced types", () => {
  const docs = serviceDocumentation.parse({
    format: 3,
    entrypoints: [],
    types: [
      {
        name: 'import("./src/query").Query',
        kind: "type",
        definition: 'type Query = { id: string; next?: import("./src/query").Query };',
        summary: "Select one item.",
        remarks: "Identifiers are case-sensitive.",
        deprecated: "Use ItemQuery for new integrations.",
        examples: ['```ts\nconst query: Query = { id: "one" };\n```'],
      },
    ],
  });

  const [type] = presentServiceDocumentation(shortenTypeNames(docs)).types;
  expect(type?.name).toBe("Query");
  expect(type?.definition).toBe("type Query = { id: string; next?: Query };");
  expect(type?.description).toContain("Deprecated: Use ItemQuery for new integrations.");
  expect(type?.examples).toContain("const query: Query = { id: &quot;one&quot; };");
});

it("shortens only unambiguous documented type references", () => {
  const docs = serviceDocumentation.parse({
    format: 3,
    entrypoints: [
      {
        name: "Reader",
        summary: "",
        remarks: "",
        examples: [],
        http: false,
        methods: [
          {
            name: "read",
            summary: "",
            remarks: "",
            examples: [],
            throws: ["Missing items.", "Missing items."],
            signatures: [
              {
                typeParameters: [
                  'T extends import("./app/query").Query = import("./app/query").Query',
                ],
                parameters: [
                  {
                    name: "query",
                    type: 'T | `import("./app/query").Query:${import("./app/query").Query}`',
                    description: "Filters:\n\n- by item\n- by owner",
                    optional: false,
                    rest: false,
                  },
                ],
                returns: {
                  type: 'Promise<[import("./app/model").Item, import("./shared/model").Item, import("./app/page").Page<import("./app/query").Query>]>',
                  description: "Matching items.\n\n```ts\nconst [item] = result;\n```",
                },
                uses: [
                  'import("./app/query").Query',
                  'import("./app/page").Page<import("./app/query").Query>',
                  'import("./app/model").Item',
                ],
              },
            ],
          },
        ],
      },
    ],
    types: [
      {
        name: 'import("./app/query").Query',
        kind: "type",
        definition:
          '{ /** Use "import(\\"./x\\").Y" literally. */ id: "import(\\"./app/query\\").Query" }',
        summary: "",
        remarks: "",
        examples: [],
      },
      {
        name: 'import("./app/page").Page<import("./app/query").Query>',
        kind: "type",
        definition: '{ items: import("./app/query").Query[] }',
        uses: ['import("./app/query").Query'],
        summary: "",
        remarks: "",
        examples: [],
      },
      ...["app", "shared"].map((folder) => ({
        name: `import("./${folder}/model").Item`,
        kind: "type",
        definition: "{ id: string }",
        summary: "",
        remarks: "",
        examples: [],
      })),
    ],
  });

  const shortened = shortenTypeNames(docs);
  const reference = presentServiceDocumentation(shortened);
  const [signature] = reference.entrypoints[0]?.methods[0]?.signatures ?? [];

  // Names, references and uses change together; a second pass changes nothing.
  expect(shortenTypeNames(shortened)).toEqual(shortened);
  expect(shortened.entrypoints[0]?.methods[0]?.signatures[0]?.uses).toEqual([
    "Query",
    "Page<Query>",
    'import("./app/model").Item',
  ]);
  expect(shortened.types[1]?.uses).toEqual(["Query"]);
  expect(reference.types.map((type) => type.name)).toEqual([
    "Query",
    "Page<Query>",
    'import("./app/model").Item',
    'import("./shared/model").Item',
  ]);
  expect(signature?.code).toBe(
    'read<T extends Query = Query>(query: T | `import("./app/query").Query:${Query}`): ' +
      'Promise<[import("./app/model").Item, import("./shared/model").Item, Page<Query>]>',
  );
  expect(reference.types[0]?.definition).toBe(docs.types[0]?.definition);
  expect(signature?.parameters[0]?.description).toContain("<li>by owner</li>");
  expect(signature?.returns.description).toContain("<pre><code");
  expect(reference.entrypoints[0]?.methods[0]?.throws).toHaveLength(2);
});

it("rejects oversized artifact documentation and renders authored HTML as text", () => {
  const docs = {
    format: 3,
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
    serviceDocumentation.safeParse({
      ...docs,
      types: [
        {
          name: "Huge",
          kind: "type",
          definition: "x".repeat(262145),
          summary: "",
          remarks: "",
          examples: [],
        },
      ],
    }).success,
  ).toBe(false);
  // Each definition is within bounds; together they exceed 8 MiB.
  expect(
    serviceDocumentation.safeParse({
      ...docs,
      types: Array.from({ length: 33 }, (_, index) => ({
        name: `Large${index}`,
        kind: "type",
        definition: "x".repeat(262144),
        summary: "",
        remarks: "",
        examples: [],
      })),
    }).success,
  ).toBe(false);
  expect(
    presentServiceDocumentation(serviceDocumentation.parse(docs)).entrypoints[0]?.description,
  ).not.toContain("<script>");

  const metadata = workerMetadata.parse({
    main_module: "worker.js",
    compatibility_date: "2026-10-01",
    entrypoints: ["Reader"],
    network: { backend: ["https://api.example.test"] },
    assets: { upload_session: crypto.randomUUID() },
  });

  // Runtimes of earlier releases accept no declared origins in their snapshots.
  expect(executionWorkerMetadata(metadata)).not.toHaveProperty("network");
  expect(metadata.network).toEqual({ backend: ["https://api.example.test"], browser: [] });
});
