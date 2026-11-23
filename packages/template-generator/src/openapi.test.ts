import { describe, expect, it } from "vitest";
import { generateOpenapi } from "./openapi.ts";

const api = {
  openapi: "3.0.4",
  servers: [{ url: "https://api.example.test/v1" }],
  paths: {
    "/folders/{folder-id}/items": {
      parameters: [{ name: "folder-id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "folders.ListItems",
        summary: "List items",
        parameters: [
          // Replaces the path's parameter of the same name.
          {
            name: "folder-id",
            in: "path",
            required: true,
            description: "The folder",
            schema: { type: "string", nullable: true },
          },
          { $ref: "#/components/parameters/top" },
          {
            name: "$select",
            in: "query",
            style: "form",
            explode: false,
            schema: { type: "array", items: { type: "string" } },
          },
          { name: "ConsistencyLevel", in: "header", schema: { type: "string" } },
          { name: "view", in: "query", required: true, schema: { type: "string" } },
          {
            name: "ids",
            in: "query",
            style: "pipeDelimited",
            explode: false,
            schema: { type: "array", items: { type: "string" } },
          },
        ],
        responses: { "2XX": { $ref: "#/components/responses/itemCollection" } },
        "x-ms-pageable": { nextLinkName: "@odata.nextLink" },
      },
      post: {
        operationId: "folders.CreateItem",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/example.item" } },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/example.item" } },
            },
          },
        },
      },
    },
    "/items/{item-id}/content": {
      get: {
        operationId: "items.GetContent",
        parameters: [{ name: "item-id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "2XX": { content: { "application/octet-stream": { schema: { type: "string" } } } },
        },
      },
      put: {
        operationId: "items.PutContent",
        parameters: [{ name: "item-id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/octet-stream": {} } },
        responses: { "204": { description: "Done" } },
      },
    },
    "/unused": { get: { operationId: "unused.Get", responses: {} } },
  },
  components: {
    parameters: {
      top: { name: "$top", in: "query", schema: { type: "integer" } },
    },
    responses: {
      itemCollection: {
        content: {
          "application/json": {
            schema: {
              allOf: [
                { $ref: "#/components/schemas/page" },
                {
                  type: "object",
                  properties: {
                    value: { type: "array", items: { $ref: "#/components/schemas/example.item" } },
                  },
                },
              ],
            },
          },
        },
      },
    },
    schemas: {
      page: {
        type: "object",
        properties: { "@odata.nextLink": { type: "string", nullable: true } },
      },
      "example.entity": {
        type: "object",
        required: ["@odata.type", "id"],
        properties: { id: { type: "string" }, "@odata.type": { type: "string" } },
      },
      "example.item": {
        allOf: [
          { $ref: "#/components/schemas/example.entity" },
          {
            type: "object",
            properties: {
              name: { type: "string", description: "The item's name." },
              size: { type: "integer", format: "int64", nullable: true },
              kind: { type: "string", enum: ["file", "folder"] },
              counts: {
                type: "object",
                properties: { label: { type: "string" } },
                additionalProperties: { type: "integer" },
              },
              mode: { anyOf: [{ $ref: "#/components/schemas/example.mode" }, { type: "string" }] },
              scope: { anyOf: [{ type: "string", enum: ["read|write"] }, { type: "integer" }] },
              tags: {
                anyOf: [
                  { type: "object", nullable: true, additionalProperties: { type: "string" } },
                  { type: "integer" },
                ],
              },
              parent: {
                anyOf: [
                  { $ref: "#/components/schemas/example.parent" },
                  { type: "object", nullable: true },
                ],
              },
              children: {
                type: "array",
                items: { $ref: "#/components/schemas/example.item" },
                "x-ms-navigationProperty": true,
              },
            },
          },
        ],
      },
      "example.parent": { type: "object", properties: { id: { type: "string" } }, nullable: true },
      "example.mode": { type: "string", enum: ["ok"], nullable: true },
      "example.unused": { type: "object", properties: { id: { type: "string" } } },
    },
  },
};

const service = {
  name: "Example",
  className: "ExampleApi",
  result: "ExampleResult",
  properties: "ExampleProperties",
  typePrefix: "example.",
};

const rules = {
  operations: {
    "folders.ListItems": { name: "listItems" },
    "folders.CreateItem": { name: "createItem", change: "create" },
    "items.GetContent": { name: "getContent" },
    "items.PutContent": { name: "putContent", change: "update" },
  },
} as const;

// The description with one part of its JSON text replaced.
const edited = (from: string, to: string) => {
  const text = JSON.stringify(api);

  if (!text.includes(from)) throw new Error(`The description has no ${from}`);

  return text.replace(from, to);
};

describe("OpenAPI template generator", () => {
  it("writes the offered operations with the types they reach", () => {
    const { files, summary } = generateOpenapi(JSON.stringify(api), rules, service, "");
    const generated = files["src/api.ts"] ?? "";

    expect(summary).toBe("4 methods of 5 operations, 5 types");
    // Prefixed schema names lose their prefix; unreached schemas are left out.
    expect(generated).toContain("export type Item = Entity & {");
    expect(generated).not.toContain("Unused");
    // Navigation properties are only returned when expanded.
    expect(generated).not.toContain("children");
    // Annotations are the server's to add; other required fields stay required.
    expect(generated).toContain('"@odata.type"?: string;');
    expect(generated).toContain("  id: string;");
    expect(generated).toContain("size?: number | null;");
    expect(generated).toContain('kind?: "file" | "folder";');
    // Named fields also fit the type of the other keys.
    expect(generated).toContain("[key: string]: number | string;");
    // A nullable enum next to string keeps its null, and quoted values stay whole.
    expect(generated).toContain("mode?: string | null;");
    expect(generated).toContain('export type Mode = "ok" | null;');
    expect(generated).toContain('scope?: "read|write" | number;');
    // An object of other keys is an object, not null.
    expect(generated).toMatch(/tags\?: \{\n\s+\[key: string\]: string;\n\s+\} \| number \| null;/);
    expect(generated).toContain("parent?: Parent | null;");
    expect(generated).toContain("folderId: string;");
    expect(generated.match(/folderId: string;/g)).toHaveLength(2);
    // A path parameter is never null, and a nullable component stays nullable.
    expect(generated).not.toContain("folderId: string | null;");
    expect(generated).toContain("export type Parent = {");
    expect(generated).toMatch(/export type Parent = \{\n  id\?: string;\n\} \| null;/);
    expect(generated).toContain("$top?: number;");
    // A later page needs only its address.
    expect(generated).toMatch(
      /\} \| \{\n(?:.*\n)*?\s+nextLink: string;\n  \}\): Promise<ExampleResult<Page/,
    );
    expect(generated).not.toContain("ConsistencyLevel");
    expect(generated).toContain("async listItems(input: {");
    expect(generated).toContain("Promise<ExampleResult<Page & {");
    expect(generated).toContain("async getContent(input: {");
    expect(generated).toContain("Promise<ExampleResult<BinaryContent>>");
    expect(generated).toContain('import type { BinaryContent } from "./content.ts";');
    expect(generated).toContain("contentType?: string;");
    expect(generated).toContain("Promise<ExampleResult<null>>");

    expect(files["src/schema.ts"]).toContain('export const base = "https://api.example.test/v1/";');
    expect(files["src/schema.ts"]).toContain(
      '"listItems":{"httpMethod":"GET","path":"/folders/{folder-id}/items","pathParameters":{"folder-id":"folderId"},"queryParameters":{"$top":["$top",null,false],"$select":["$select",",",false],"view":["view",null,true],"ids":["ids","|",false]},"headerParameters":{},"body":null,"bodyRequired":false,"response":"json","pageable":true,"change":null}',
    );
    expect(files["src/schema.ts"]).toContain('"body":"text","bodyRequired":true,"response":null');
  });

  it("offers operations that only read through a POST without asking", () => {
    const { files } = generateOpenapi(
      JSON.stringify(api),
      { operations: { "folders.CreateItem": { name: "findItems", change: "read" } } },
      service,
      "",
    );

    expect(files["src/schema.ts"]).toContain('"httpMethod":"POST"');
    expect(files["src/schema.ts"]).toContain('"change":null');
  });

  it("describes operations with the rules' text where it replaces the API's", () => {
    const { files } = generateOpenapi(
      JSON.stringify(api),
      { operations: { "folders.ListItems": { name: "listItems", description: "Lists items." } } },
      service,
      "",
    );

    expect(files["src/api.ts"]).toContain("   * Lists items.\n   */\n  async listItems");
    expect(files["src/api.ts"]).not.toContain("List items\n");
  });

  it("sends the headers the rules add as optional inputs", () => {
    const session = { sessionId: { name: "session-id", description: "The session to work in." } };

    const { files } = generateOpenapi(
      JSON.stringify(api),
      { operations: { "items.GetContent": { name: "getContent", headers: session } } },
      service,
      "",
    );

    expect(files["src/api.ts"]).toContain(
      "    /**\n     * The session to work in.\n     */\n    sessionId?: string;",
    );
    expect(files["src/schema.ts"]).toContain('"headerParameters":{"sessionId":"session-id"}');

    // A later page keeps the headers of the first.
    const paged = generateOpenapi(
      JSON.stringify(api),
      { operations: { "folders.ListItems": { name: "listItems", headers: session } } },
      service,
      "",
    ).files["src/api.ts"];

    expect(paged).toMatch(
      /nextLink: string;\n    \/\*\*\n     \* The session to work in\.\n     \*\/\n    sessionId\?: string;\n  \}\): Promise/,
    );

    expect(() =>
      generateOpenapi(
        JSON.stringify(api),
        {
          operations: {
            "items.GetContent": {
              name: "getContent",
              headers: { itemId: { name: "item", description: "The item." } },
            },
          },
        },
        service,
        "",
      ),
    ).toThrow("items.GetContent has two inputs named itemId");
  });

  it("adds operations the description leaves out at a described operation's path", () => {
    const updateItem = {
      operation: "items.GetContent",
      method: "patch",
      change: "update",
      description: "Updates the item.",
      body: ["example.item"],
      result: ["example.item"],
    } as const;

    const { files } = generateOpenapi(
      JSON.stringify(api),
      {
        operations: {},
        undescribed: {
          updateItem,
          clearItem: { ...updateItem, method: "post", result: undefined },
        },
      },
      service,
      "",
    );

    expect(files["src/api.ts"]).toContain(
      "   * Updates the item.\n   *\n   * Asks the user first unless their approval level is `none`.\n   */\n  async updateItem(input: {\n    itemId: string;\n    /**\n     * The request body.\n     */\n    body: Item;\n  }): Promise<ExampleResult<Item>>",
    );
    expect(files["src/api.ts"]).toContain("async clearItem(input: {");
    expect(files["src/api.ts"]).toContain("Promise<ExampleResult<null>>");
    expect(files["src/schema.ts"]).toContain(
      '"updateItem":{"httpMethod":"PATCH","path":"/items/{item-id}/content","pathParameters":{"item-id":"itemId"},"queryParameters":{},"headerParameters":{},"body":"json","bodyRequired":true,"response":"json","pageable":false,"change":"update"}',
    );
    expect(files["src/schema.ts"]).toContain(
      '"clearItem":{"httpMethod":"POST","path":"/items/{item-id}/content","pathParameters":{"item-id":"itemId"},"queryParameters":{},"headerParameters":{},"body":"json","bodyRequired":true,"response":null',
    );

    // An added method follows the method whose path it shares.
    const ordered = generateOpenapi(
      JSON.stringify(api),
      { operations: rules.operations, undescribed: { updateItem } },
      service,
      "",
    ).files["src/api.ts"];

    expect(ordered?.match(/async (\w+)/g)).toEqual([
      "async listItems",
      "async createItem",
      "async getContent",
      "async updateItem",
      "async putContent",
    ]);

    // The generator stops once the API describes the operation, or no longer the path.
    expect(() =>
      generateOpenapi(
        JSON.stringify(api),
        {
          operations: {},
          undescribed: {
            updateItem,
            putItem: { ...updateItem, method: "put" },
            goneItem: { ...updateItem, operation: "gone.Get" },
            // Another name for the same request would replace updateItem.
            patchItem: updateItem,
          },
        },
        service,
        "",
      ),
    ).toThrow(
      [
        "The API now describes PUT items.GetContent; offer its operation instead of putItem",
        "goneItem uses the path of gone.Get, which the API no longer offers",
        "patchItem repeats the undescribed target PATCH items.GetContent",
      ].join("\n"),
    );
  });

  it("reads YAML descriptions", () => {
    const yaml = `openapi: 3.0.4
servers:
  - url: https://api.example.test
paths:
  /status:
    get:
      operationId: status.Get
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok:
                    type: boolean
`;

    expect(
      generateOpenapi(yaml, { operations: { "status.Get": { name: "status" } } }, service, "")
        .files["src/api.ts"],
    ).toContain("ok?: boolean;");
  });

  it("stops on changes without a kind, stale rules and taken names", () => {
    expect(() =>
      generateOpenapi(
        JSON.stringify(api),
        {
          operations: {
            "folders.CreateItem": { name: "createItem" },
            "gone.Get": { name: "gone" },
            "items.GetContent": { name: "fetch" },
            // Widefleet refuses these as app methods.
            "items.PutContent": { name: "catch", change: "update" },
          },
        },
        service,
        "",
      ),
    ).toThrow(
      [
        "POST folders.CreateItem changes data; give it a change",
        "The rules list gone.Get, which the API no longer offers",
        "items.GetContent becomes method fetch, which is taken",
        "items.PutContent becomes method catch, which is taken",
      ].join("\n"),
    );
  });

  it("types every success answer and refuses one of JSON and other content", () => {
    // A JSON 201 next to an empty 204 may answer null.
    const withEmpty = edited(
      '"responses":{"201":{"content"',
      '"responses":{"204":{"description":"Unchanged"},"201":{"content"',
    );

    expect(generateOpenapi(withEmpty, rules, service, "").files["src/api.ts"]).toContain(
      "Promise<ExampleResult<Item | null>>",
    );

    const mixed = edited(
      '"responses":{"201":{"content"',
      '"responses":{"202":{"content":{"text/csv":{}}},"201":{"content"',
    );

    expect(() => generateOpenapi(mixed, rules, service, "")).toThrow(
      "folders.CreateItem answers with JSON and with other content",
    );
  });

  it("keeps query names and refuses path styles it cannot write", () => {
    const hyphenated = edited('"name":"view","in":"query"', '"name":"api-version","in":"query"');
    const { files } = generateOpenapi(hyphenated, rules, service, "");

    expect(files["src/api.ts"]).toContain('"api-version": string;');
    expect(files["src/schema.ts"]).toContain('"api-version":["api-version",null,true]');

    const labelled = edited(
      '"name":"item-id","in":"path","required":true,"schema"',
      '"name":"item-id","in":"path","required":true,"style":"label","schema"',
    );

    expect(() => generateOpenapi(labelled, rules, service, "")).toThrow(
      "items.GetContent's path parameter item-id has the unsupported style label",
    );
  });

  it("types bodies and results with the schemas the rules name", () => {
    const { files } = generateOpenapi(
      JSON.stringify(api),
      {
        operations: {
          "folders.CreateItem": {
            name: "createItem",
            change: "create",
            body: ["example.item", "example.parent"],
            result: ["example.parent"],
          },
        },
      },
      service,
      "",
    );

    expect(files["src/api.ts"]).toContain("body: Item | Parent;");
    expect(files["src/api.ts"]).toContain("Promise<ExampleResult<Parent>>");
  });

  it("keeps the navigation properties the rules name, typed with their schemas", () => {
    const { files } = generateOpenapi(
      JSON.stringify(api),
      {
        ...rules,
        navigation: { "example.item": { children: ["example.item", "example.parent"] } },
      },
      service,
      "",
    );

    expect(files["src/api.ts"]).toContain("children?: (Item | Parent)[];");

    // A kept navigation field must also fit the type of the other keys.
    const open = edited(
      '"properties":{"name":{"type":"string"',
      '"additionalProperties":{"type":"string"},"properties":{"name":{"type":"string"',
    );

    const typed = generateOpenapi(
      open,
      {
        ...rules,
        navigation: { "example.item": { children: ["example.item", "example.parent"] } },
      },
      service,
      "",
    ).files["src/api.ts"];

    expect(typed).toContain("} | Parent | (Item | Parent)[];");
  });

  it("binds the navigation properties the rules name by address", () => {
    const parent = edited(
      '"parent":{"anyOf":[{"$ref":"#/components/schemas/example.parent"},{"type":"object","nullable":true}]}',
      '"parent":{"anyOf":[{"$ref":"#/components/schemas/example.parent"},{"type":"object","nullable":true}],"x-ms-navigationProperty":true}',
    );

    const generated = generateOpenapi(
      parent,
      { ...rules, bindings: { "example.item": ["parent", "children"] } },
      service,
      "",
    ).files["src/api.ts"];

    expect(generated).toContain(
      '  /**\n   * Binds parent to the existing entity at this address.\n   */\n  "parent@odata.bind"?: string;',
    );
    expect(generated).toContain('"children@odata.bind"?: string[];');
    // Bound navigation properties themselves stay out.
    expect(generated).not.toContain("children?:");

    expect(() =>
      generateOpenapi(parent, { ...rules, bindings: { "example.item": ["name"] } }, service, ""),
    ).toThrow("The bindings name example.item.name, which is not a navigation property");
  });

  it("takes any JSON where a JSON body or result has no schema", () => {
    const item = '{"schema":{"$ref":"#/components/schemas/example.item"}}';

    const loose = edited(
      `"requestBody":{"required":true,"content":{"application/json":${item}}},"responses":{"201":{"content":{"application/json":${item}}}}`,
      '"requestBody":{"required":true,"content":{"application/json":{}}},"responses":{"201":{"content":{"application/json":{}}}}',
    );

    const { files } = generateOpenapi(
      loose,
      { operations: { "folders.CreateItem": { name: "createItem", change: "create" } } },
      service,
      "",
    );

    expect(files["src/api.ts"]).toContain("body: JsonValue;");
    expect(files["src/api.ts"]).toContain("Promise<ExampleResult<JsonValue>>");
    expect(files["src/schema.ts"]).toContain('"body":"json","bodyRequired":true,"response":"json"');
  });

  it("stops on clashing inputs and object queries, but not on unused schema names", () => {
    const contentParameters = '"operationId":"items.GetContent","parameters":[';
    const getContent = { operations: { "items.GetContent": { name: "getContent" } } };

    const clashing = edited(
      contentParameters,
      `${contentParameters}{"name":"itemId","in":"query","schema":{"type":"string"}},`,
    );

    expect(() => generateOpenapi(clashing, getContent, service, "")).toThrow(
      "items.GetContent has two inputs named itemId",
    );

    const objectQuery = edited(
      contentParameters,
      `${contentParameters}{"name":"filter","in":"query","schema":{"type":"object","properties":{"owner":{"type":"string"}}}},`,
    );

    expect(() => generateOpenapi(objectQuery, getContent, service, "")).toThrow(
      "items.GetContent has the object query parameter filter, which is not supported",
    );

    const listPath = edited(
      '"/items/{item-id}/content":{"get":{"operationId":"items.GetContent","parameters":[{"name":"item-id","in":"path","required":true,"schema":{"type":"string"}}',
      '"/items/{item-id}/content":{"get":{"operationId":"items.GetContent","parameters":[{"name":"item-id","in":"path","required":true,"schema":{"type":"array","items":{"type":"string"}}}',
    );

    expect(() => generateOpenapi(listPath, getContent, service, "")).toThrow(
      "items.GetContent has the path parameter item-id with a list or object, which is not supported",
    );

    // Unused schemas may share a name.
    const unused = edited(
      '"example.unused":',
      '"example.user":{"type":"object"},"example.User":{"type":"object"},"example.unused":',
    );

    expect(generateOpenapi(unused, rules, service, "").summary).toBe(
      "4 methods of 5 operations, 5 types",
    );

    // Generated names stay free for the imports.
    const shadowing = edited(
      '"example.unused":',
      '"example.BinaryContent":{"type":"object"},"example.unused":',
    ).replace(
      '"parent":{"anyOf":[{"$ref":"#/components/schemas/example.parent"},{"type":"object","nullable":true}]}',
      '"parent":{"$ref":"#/components/schemas/example.BinaryContent"}',
    );

    expect(() => generateOpenapi(shadowing, rules, service, "")).toThrow(
      "The API's types BinaryContent have the names of imports of the generated file",
    );
  });
});
