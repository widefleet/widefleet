import { describe, expect, it } from "vitest";
import { generateOpenapi, mergeDescriptions } from "./openapi.ts";
import { isOpenapi31, upgradeOpenapi31 } from "./openapi31.ts";

const service = {
  name: "Example",
  className: "ExampleApi",
  result: "ExampleResult",
  properties: "ExampleProperties",
};

// One operation's page in the shape Qonto publishes: a complete OpenAPI 3.1
// document with the components the operation uses.
const page = (path: string, operationId: string, schema: string) => ({
  openapi: "3.1.1",
  servers: [{ url: "https://api.example.test" }],
  paths: {
    [path]: {
      get: {
        operationId,
        responses: {
          "200": {
            content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      [schema]: {
        type: "object",
        properties: {
          id: { type: "string" },
          note: { type: ["string", "null"], examples: [{ type: ["kept"] }] },
          amount: { type: ["integer", "string"] },
          side: { const: "debit" },
          cleared: { type: "null" },
          // A field named after a keyword keeps its schema.
          type: { type: ["array", "null"], items: { type: "string" } },
        },
        required: ["id"],
      },
      Shared: { type: "string" },
    },
  },
});

describe("OpenAPI 3.1 descriptions", () => {
  it("reads nullable type lists, unions and fixed values as OpenAPI 3.0 schemas", () => {
    const transfer = page("/transfers", "listTransfers", "Transfer");
    expect(isOpenapi31(transfer)).toBe(true);
    expect(isOpenapi31({ openapi: "3.0.4" })).toBe(false);

    expect(upgradeOpenapi31(transfer)).toMatchObject({
      components: {
        schemas: {
          Transfer: {
            type: "object",
            properties: {
              note: { type: "string", nullable: true, examples: [{ type: ["kept"] }] },
              amount: { anyOf: [{ type: "integer" }, { type: "string" }] },
              side: { enum: ["debit"] },
              cleared: { enum: [null] },
              type: { type: "array", nullable: true, items: { type: "string" } },
            },
          },
        },
      },
    });

    expect(
      generateOpenapi(
        transfer,
        { operations: { listTransfers: { name: "listTransfers" } } },
        service,
        "",
      ).files["src/api.ts"],
    ).toContain(`export type Transfer = {
  id: string;
  note?: string | null;
  amount?: number | string;
  side?: "debit";
  cleared?: null;
  type?: string[] | null;
};`);
  });

  it("joins a description published one operation per page", () => {
    const merged = mergeDescriptions([
      page("/transfers", "listTransfers", "Transfer"),
      page("/cards", "listCards", "Card"),
    ]);

    expect(
      generateOpenapi(
        merged,
        {
          operations: {
            listTransfers: { name: "listTransfers" },
            listCards: { name: "listCards" },
          },
        },
        service,
        "",
      ).summary,
    ).toBe("2 methods of 2 operations, 2 types");

    // Parts that disagree stop the generator rather than pick one.
    const changed = page("/cards", "listCards", "Card");
    changed.components.schemas["Shared"] = { type: "integer" };

    expect(() =>
      mergeDescriptions([page("/transfers", "listTransfers", "Transfer"), changed]),
    ).toThrow("The description's parts describe schemas.Shared differently");

    expect(() =>
      mergeDescriptions([
        page("/transfers", "listTransfers", "Transfer"),
        {
          ...page("/cards", "listCards", "Card"),
          servers: [{ url: "https://other.example.test" }],
        },
      ]),
    ).toThrow("The description's parts differ outside their paths and components");
  });
});
