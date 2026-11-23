import { describe, expect, it } from "vitest";
import { generateDiscovery } from "./discovery.ts";

const document = JSON.stringify({
  rootUrl: "https://example.googleapis.com/",
  servicePath: "",
  schemas: {
    Item: {
      id: "Item",
      type: "object",
      description: "An item.",
      properties: {
        id: { type: "string" },
        size: { type: "string", format: "int64" },
        kind: { type: "string", enum: ["a", "b"], enumDescriptions: ["First", "Second"] },
        children: { type: "array", items: { $ref: "Item" } },
      },
    },
  },
  resources: {
    users: {
      resources: {
        items: {
          methods: {
            get: {
              id: "example.users.items.get",
              path: "v1/users/{userId}/items/{id}",
              httpMethod: "GET",
              parameters: {
                userId: { location: "path", type: "string", required: true, default: "me" },
                id: { location: "path", type: "string", required: true },
                view: { location: "query", type: "string", enum: ["full", "minimal"] },
                types: { location: "query", type: "string", repeated: true, enum: ["x", "y"] },
              },
              response: { $ref: "Item" },
              scopes: ["https://example/readonly", "https://example/full"],
            },
            send: {
              id: "example.users.items.send",
              path: "v1/users/{userId}/items/send",
              httpMethod: "POST",
              parameters: {
                userId: { location: "path", type: "string", required: true, default: "me" },
              },
              request: { $ref: "Item" },
              response: { $ref: "Item" },
              scopes: ["https://example/full"],
            },
            delete: {
              id: "example.users.items.delete",
              path: "v1/users/{userId}/items/{id}",
              httpMethod: "DELETE",
              parameters: {
                userId: { location: "path", type: "string", required: true, default: "me" },
                id: { location: "path", type: "string", required: true },
              },
              scopes: ["https://example/full"],
            },
          },
        },
      },
    },
  },
});

const service = {
  name: "Example",
  className: "ExampleApi",
  result: "ExampleResult",
  properties: "ExampleProperties",
};

describe("Discovery template generator", () => {
  it("writes typed methods, request metadata and the scopes that cover them", () => {
    const { files, summary } = generateDiscovery(
      document,
      {
        operations: { "example.users.items.send": "send", "example.users.items.delete": "delete" },
      },
      service,
      "// header\n",
    );

    const api = files["src/api.ts"] ?? "";
    const schema = files["src/schema.ts"] ?? "";

    expect(summary).toBe("3 methods, 0 not offered, 1 types");
    // The resource every method shares is left out of the names.
    expect(api).toContain("async itemsGet<S extends Selection<Item>>(");
    expect(api).toContain("async itemsDelete(");
    expect(api).toContain("Promise<ExampleResult<null>>");
    expect(api).toContain("export type Item = {");
    expect(api).toContain("size?: string;");
    expect(api).toContain('kind?: "a" | "b";');
    expect(api).toContain("userId?: string;");
    expect(api).toContain("body: Item;");
    // A repeated parameter with choices takes a list of them.
    expect(api).toContain('types?: ("x" | "y")[];');
    expect(schema).toContain('"itemsSend":{"httpMethod":"POST"');
    expect(schema).toContain('"change":"send"');
    expect(schema).toContain('export const scopes = ["https://example/full"];');
    expect(schema).toContain('export const base = "https://example.googleapis.com/";');
  });

  it("stops on changing methods the rules do not list", () => {
    expect(() =>
      generateDiscovery(
        document,
        { operations: { "example.users.items.delete": "delete" } },
        service,
        "",
      ),
    ).toThrow(/^POST example\.users\.items\.send is new; add it to the rules/);
  });

  it("stops on rules the API no longer has", () => {
    expect(() =>
      generateDiscovery(
        document,
        {
          operations: {
            "example.users.items.send": "send",
            "example.users.items.delete": "delete",
            "example.users.items.gone": "update",
          },
        },
        service,
        "",
      ),
    ).toThrow(/^The rules list example\.users\.items\.gone, which the API no longer offers$/);
  });

  it("offers methods that only read without asking", () => {
    const { files } = generateDiscovery(
      document,
      {
        operations: {
          "example.users.items.send": "read",
          "example.users.items.delete": "delete",
        },
      },
      service,
      "",
    );

    expect(files["src/schema.ts"]).toContain(
      '"itemsSend":{"httpMethod":"POST","path":"v1/users/{userId}/items/send","pathParameters":{"userId":"me"},"queryParameters":[],"body":true,"response":true,"change":null}',
    );
  });

  it("leaves out hidden methods", () => {
    const { files } = generateDiscovery(
      document,
      {
        operations: {
          "example.users.items.send": { hidden: "serviceAccount" },
          "example.users.items.delete": "delete",
          "example.users.items.get": { hidden: "serviceAccount" },
        },
      },
      service,
      "",
    );

    expect(files["src/api.ts"]).not.toContain("itemsSend");
    expect(files["src/api.ts"]).not.toContain("itemsGet");
  });
});
