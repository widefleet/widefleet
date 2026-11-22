import { describe, expect, it } from "vitest";
import { serviceBindingTypes } from "./service-binding-types.ts";
import { serviceDocumentation } from "./service-documentation.ts";
import { shortenTypeNames } from "./service-type-names.ts";

const type = (
  name: string,
  definition: string,
  kind: "interface" | "type" = "type",
  typeParameters?: string[],
) => ({
  name,
  kind,
  definition,
  ...(typeParameters && { typeParameters }),
  summary: "",
  remarks: "",
  examples: [],
});

const documentation = (returns: string, types: ReturnType<typeof type>[]) =>
  serviceDocumentation.parse({
    format: 3,
    entrypoints: [
      {
        name: "default",
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
              { parameters: [], returns: { type: `Promise<${returns}>`, description: "" } },
            ],
          },
        ],
      },
    ],
    types,
  });

const generate = (value: ReturnType<typeof documentation>, binding = "API") =>
  serviceBindingTypes(value, { app: "inventory", entrypoint: "default", binding });

describe("service binding types", () => {
  it("names same-named types from different modules after their modules", () => {
    const stored = shortenTypeNames(
      documentation('[import("./src/a").Item, import("./src/b/index").Item, src_a_Item]', [
        type('import("./src/a").Item', "{ a: string }"),
        type('import("./src/b/index").Item', '{ b: import("./src/a").Item }'),
        // Already uses the name the first module's Item would get.
        type("src_a_Item", "{ c: number }"),
      ]),
    );

    const { declarations } = generate(stored);
    expect(declarations).toContain(
      "read(): Promise<API.Result<[src_a_Item_, src_b_Item, src_a_Item]>>;",
    );
    expect(declarations).toContain("export type src_a_Item_ = { a: string };");
    expect(declarations).toContain("export type src_b_Item = { b: src_a_Item_ };");
    expect(declarations).toContain("export type src_a_Item = { c: number };");
  });

  it("replaces undeclared references with unknown and keeps them in comments", () => {
    const { declarations } = generate(
      documentation(
        'Reply<import("./node_modules/vendor/index").Box<{ a: "*/" }, () => void>, typeof import("./src/values").defaults>',
        [type("Reply<T, U>", "{ value: T; fallback: U }", "type", ["T", "U"])],
      ),
    );

    expect(declarations).toContain(
      'read(): Promise<API.Result<Reply<unknown /* import("./node_modules/vendor/index").Box<{ a: "* /" }, () => void> */, unknown /* typeof import("./src/values").defaults */>>>;',
    );
    expect(declarations).toContain('// - import("./node_modules/vendor/index").Box');
    expect(declarations).toContain('// - import("./src/values").defaults');
    expect(declarations).toContain("export type Reply<T, U> = { value: T; fallback: U };");
  });

  it("puts field descriptions on members of object types and behind other definitions", () => {
    const { declarations } = generate(
      documentation("[Item, Result]", [
        type(
          "Item",
          '{\n    readonly id: string;\n    "kind"?: number;\n    find(id: string): Item;\n}\n/** id: The identifier. */\n/** kind: The kind: a number. */\n/** find: Find one. */',
          "interface",
        ),
        type("Result", "{\n    ok: true;\n} | {\n    ok: false;\n}\n/** ok: Whether it worked. */"),
      ]),
    );

    expect(declarations).toContain(
      'export interface Item {\n    /**\n     * The identifier.\n     */\n    readonly id: string;\n    /**\n     * The kind: a number.\n     */\n    "kind"?: number;\n    /**\n     * Find one.\n     */\n    find(id: string): Item;\n}',
    );
    expect(declarations).toContain(
      "export type Result = {\n    ok: true;\n} | {\n    ok: false;\n}\n/** ok: Whether it worked. */;",
    );
  });

  it("refuses names the declarations need", () => {
    const value = documentation("Promise<API>", [type("API", "{}"), type("Promise<T>", "T")]);

    expect(generate(value).failure).toEqual({
      reason: "name",
      message: "The API documents a type named API; choose another binding name",
    });
    expect(generate(value, "INVENTORY").failure).toEqual({
      reason: "name",
      message: "The API documents a type named Promise, which the binding's methods need",
    });

    for (const binding of ["class", "string", "keyof", "Promise", "globalThis", "1API"])
      expect(generate(documentation("number", []), binding).failure).toEqual({
        reason: "name",
        message: `${binding} cannot name a TypeScript interface; choose another binding name`,
      });

    expect(
      serviceBindingTypes(value, { app: "inventory", entrypoint: "Reader", binding: "INVENTORY" })
        .failure,
    ).toEqual({ reason: "entrypoint", message: "Reader is not a documented entrypoint" });
  });
});
