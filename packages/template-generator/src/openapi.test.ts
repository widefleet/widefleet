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
    expect(generated).toContain("parent?: Parent | null;");
    expect(generated).toContain("folderId: string;");
    expect(generated.match(/folderId: string;/g)).toHaveLength(2);
    // A path parameter is never null, and a nullable component stays nullable.
    expect(generated).not.toContain("folderId: string | null;");
    expect(generated).toContain("export type Parent = {");
    expect(generated).toMatch(/export type Parent = \{\n  id\?: string;\n\} \| null;/);
    expect(generated).toContain("$top?: number;");
    expect(generated).toContain("nextLink?: string;");
    expect(generated).not.toContain("ConsistencyLevel");
    expect(generated).toContain("async listItems(input: {");
    expect(generated).toContain("Promise<ExampleResult<Page & {");
    expect(generated).toContain("async getContent(input: {");
    expect(generated).toContain("Promise<ExampleResult<BinaryContent>>");
    expect(generated).toContain('import type { BinaryContent } from "./rest.ts";');
    expect(generated).toContain("contentType?: string;");
    expect(generated).toContain("Promise<ExampleResult<null>>");

    expect(files["src/schema.ts"]).toContain('export const base = "https://api.example.test/v1/";');
    expect(files["src/schema.ts"]).toContain(
      '"listItems":{"httpMethod":"GET","path":"/folders/{folder-id}/items","pathParameters":{"folder-id":"folderId"},"queryParameters":{"$top":["$top",true,false],"$select":["$select",false,false],"view":["view",true,true]},"body":null,"bodyRequired":false,"response":"json","pageable":true,"change":null}',
    );
    expect(files["src/schema.ts"]).toContain('"body":"text","bodyRequired":true,"response":null');
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
      ].join("\n"),
    );
  });
});
