import { build } from "esbuild";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { serviceBindingTypes, shortenTypeNames } from "@platform/contracts";
import { extractServiceDocumentation } from "./service-documentation-fixture.ts";

const native = it.runIf(process.env["RUN_CLI_TESTS"] === "1");

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0).reverse())
    await rm(directory, { recursive: true, force: true });
});

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

const strictest = fileURLToPath(
  new URL("../../../node_modules/@tsconfig/strictest/tsconfig.json", import.meta.url),
);

// Diagnostics of a caller that uses the generated file, compiled with the strictest options and
// without skipping declaration files, so errors in the generated declarations surface too.
const compile = (root: string, files: string[]) => {
  const { options } = ts.parseJsonConfigFileContent(
    {
      extends: strictest,
      compilerOptions: {
        skipLibCheck: false,
        noEmit: true,
        target: "es2023",
        module: "esnext",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        lib: ["es2023"],
        types: [],
      },
    },
    ts.sys,
    root,
  );

  const program = ts.createProgram(
    files.map((file) => join(root, file)),
    options,
  );

  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
};

const provider = {
  "workers.d.ts": `declare module "cloudflare:workers" {
  export class WorkerEntrypoint<E = unknown, P = unknown> { protected env: E; protected ctx: { props: P }; }
}`,
  "node_modules/vendor/package.json": JSON.stringify({ name: "vendor", types: "index.d.ts" }),
  "node_modules/vendor/index.d.ts": "export declare class Token { value: string; }",
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "es2022",
      module: "esnext",
      moduleResolution: "bundler",
    },
    include: ["**/*.ts"],
  }),
  "src/model.ts": `/** An item in a list. */
export interface Item {
  /** Stable identifier. */
  id: string;
}

/** A page of items with a link to the next. */
export interface Page<T extends Item = Item> {
  items: T[];
  /** The following page, or null on the last page. */
  next: Page<T> | null;
}

/** A node of a category tree. */
export type Tree = { name: string; children: Tree[] };

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
`,
  "src/a/record.ts": "export interface Entry { a: string }",
  "src/b/record.ts": "export interface Entry { b: number }",
  "src/app.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
import type { Token } from "vendor";
import type { Entry as First } from "./a/record.ts";
import type { Entry as Second } from "./b/record.ts";
import type { Item, Json, Page, Tree } from "./model.ts";

type Input = { inputResponses: { confirm?: { action: string } }; requestState: { text: string } };

/** Lists and changes items. */
export class Items extends WorkerEntrypoint<unknown, { input?: Input }> {
  /**
   * List items of a kind.
   * @param kind - Which items to list.
   * @returns The first page.
   */
  async list<T extends Item = Item>(kind: string): Promise<Page<T>> {
    throw new Error(kind);
  }

  tree(): Tree {
    return { name: "root", children: [] };
  }

  value(): Json {
    return null;
  }

  entries(): [First, Second] {
    return [{ a: "a" }, { b: 1 }];
  }

  token(): Token {
    throw new Error();
  }

  /** Send an item after the user confirms. */
  async send(id: string) {
    const input = this.ctx.props.input;

    if (!input)
      return {
        resultType: "input_required" as const,
        inputRequests: { confirm: { message: \`Send \${id}?\` } },
        requestState: { text: id },
      };

    return { sent: input.inputResponses.confirm?.action === "accept" };
  }

  fetch() {
    return new Response();
  }
}
`,
};

const caller = `import type { ITEMS, Item, Json, Page, src_a_record_Entry, src_b_record_Entry, Tree } from "./items.d.ts";

declare const items: ITEMS;

type Named = Item & { name: string };

export const run = async () => {
  const page = await items.list<Named>("tools");
  const name: string | undefined = page.items[0]?.name;
  const next: Page<Named> | null = page.next;
  const defaulted: Page = await items.list("tools");
  // @ts-expect-error The type argument must be an item.
  await items.list<{ name: string }>("tools");
  // @ts-expect-error The kind is required.
  await items.list();

  const tree: Tree = await items.tree();
  const child: string | undefined = tree.children[0]?.children[0]?.name;
  const json: Json = await items.value();
  const [first, second]: [src_a_record_Entry, src_b_record_Entry] = await items.entries();
  const a: string = first.a;
  const b: number = second.b;

  const token = await items.token();
  // @ts-expect-error Types the documentation does not declare are unknown.
  void token.value;

  const sent = await items.send("item-1");

  if (sent.resultType === "input_required") {
    const state: string = sent.requestState;
    const message: string | undefined = sent.inputRequests.confirm?.message;
    const answered = await items
      .withInput({ inputResponses: { confirm: { action: "accept" } }, requestState: state })
      .send("item-1");
    // @ts-expect-error withInput returns the methods only.
    void items.withInput({ inputResponses: {}, requestState: state }).fetch;
    // @ts-expect-error Callers pass the sealed state back unchanged.
    void items.withInput({ inputResponses: {}, requestState: { text: "item-1" } });
    void [message, answered];
  } else {
    const done: boolean = sent.sent;
    void done;
  }

  const response = await items.fetch("https://items.example.test/");
  void [name, next, defaulted, child, json, a, b, response];
};
`;

native(
  "generates binding types that callers compile against with the provider's types",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "service binding types ")));
    directories.push(root);
    await write(root, provider);
    const bundle = join(root, "final/worker.js");
    await build({
      entryPoints: [join(root, "src/app.ts")],
      outfile: bundle,
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      sourcemap: true,
      external: ["cloudflare:workers"],
    });

    const { documentation, warnings } = await extractServiceDocumentation(root, bundle, ["Items"]);
    expect(warnings).toEqual([]);
    const stored = shortenTypeNames(documentation);
    const options = { app: "items", entrypoint: "Items", binding: "ITEMS" };
    const { declarations } = serviceBindingTypes(stored, options);

    expect(declarations).toContain(
      "// Generated by `widefleet services types items --entrypoint Items --as ITEMS`",
    );
    const token = 'import("./node_modules/vendor/index").Token';
    expect(declarations).toContain(`// - ${token}`);
    expect(declarations).toContain(`token(): Promise<ITEMS.Result<unknown /* ${token} */>>;`);
    // Field descriptions are member comments, so editors show them.
    expect(declarations).toMatch(
      /\/\*\*\n \* An item in a list\.\n \*\/\nexport interface Item \{/,
    );
    expect(declarations).toMatch(
      / {4}\/\*\*\n {5}\* Stable identifier\.\n {5}\*\/\n {4}id: string;/,
    );
    expect(declarations).toContain("export interface Page<T extends Item = Item> {");
    expect(declarations).toContain("   * @param kind - Which items to list.");

    // Document order does not change the result.
    expect(
      serviceBindingTypes({ ...stored, types: [...stored.types].reverse() }, options).declarations,
    ).toBe(declarations);

    await write(root, { "caller/items.d.ts": declarations ?? "", "caller/caller.ts": caller });
    await writeFile(
      join(root, "caller/globals.d.ts"),
      "declare function fetch(input: string): Promise<{ ok: boolean }>;",
    );
    expect(compile(join(root, "caller"), ["caller.ts", "globals.d.ts"])).toEqual([]);
  },
);
