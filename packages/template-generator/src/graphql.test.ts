import { describe, expect, it } from "vitest";
import { generateGraphql } from "./graphql.ts";

const sdl = `
type Query {
  "Finds an item."
  item(id: ID!): Item!
  items(first: Int): [Item!]!
  version: String!
}

type Mutation {
  itemCreate(name: String!): Item!
  itemDelete(id: ID!): Boolean!
  login(code: String!): Boolean!
}

type Item {
  id: ID!
  name: String!
  "Related items."
  related(first: Int): [Item!]!
}
`;

const service = {
  name: "Example",
  className: "ExampleApi",
  result: "ExampleResult",
  properties: "ExampleProperties",
};

const rules = {
  mutations: {
    itemCreate: "create",
    itemDelete: "delete",
    login: { hidden: "signIn" },
  },
  queries: { version: { name: "apiVersion" } },
} as const;

describe("GraphQL template generator", () => {
  it("writes one typed method per offered operation with its change", () => {
    const { files, summary } = generateGraphql(sdl, rules, service, "// header\n");
    const api = files["src/api.ts"] ?? "";

    expect(summary).toBe("5 methods, 1 operations not offered, 1 types");
    expect(api).toContain(
      "export class ExampleApi extends WorkerEntrypoint<TemplateEnvironment, ExampleProperties>",
    );
    expect(api).toContain("async item<S extends Selection<Item>>(");
    expect(api).toContain(
      "async apiVersion(input: Record<string, never>): Promise<ExampleResult<string>>",
    );
    expect(api).toContain('{ root: "Mutation", field: "itemDelete", change: "delete" }');
    expect(api).not.toContain("login");
    expect(api).toContain("related(args?: {");
    expect(files["src/schema.ts"]).toContain('"related":["Item",{"first":"Int"}]');
  });

  it("stops on mutations the rules do not list and on rules the schema no longer has", () => {
    expect(() =>
      generateGraphql(
        sdl,
        {
          mutations: { itemCreate: "create", login: { hidden: "signIn" }, gone: "update" },
          queries: {},
        },
        service,
        "",
      ),
    ).toThrow(
      /Mutation itemDelete is new[\s\S]*gone, which the schema no longer offers|gone, which the schema no longer offers[\s\S]*Mutation itemDelete is new/,
    );
  });

  it("refuses names that become reserved or collide", () => {
    expect(() =>
      generateGraphql(sdl, { ...rules, queries: { version: { name: "items" } } }, service, ""),
    ).toThrow("Query.version becomes method items, which is taken");
    expect(() =>
      generateGraphql(sdl, { ...rules, queries: { version: { name: "fetch" } } }, service, ""),
    ).toThrow("Query.version becomes method fetch, which is taken");
  });

  it("keeps API types named like the template's environment and refuses ones that shadow imports", () => {
    const named = (name: string) =>
      `${sdl}\ntype ${name} { id: ID! }\nextend type Query { other: ${name}! }`;

    const { files } = generateGraphql(named("Environment"), rules, service, "");

    expect(files["src/api.ts"]).toContain("export interface Environment {");
    expect(files["src/api.ts"]).toContain(
      "extends WorkerEntrypoint<TemplateEnvironment, ExampleProperties>",
    );
    expect(() => generateGraphql(named("Selection"), rules, service, "")).toThrow(
      "The API's types Selection have the names of imports of the generated file",
    );
  });
});
