import { describe, expect, it } from "vitest";
import { z } from "zod";
import { comment, jsonSchema, methodName, optionalInput, schemaType } from "./schema-types.ts";

const typeOf = (schema: z.infer<ReturnType<typeof z.json>>) => schemaType(jsonSchema.parse(schema));

describe("Linear tool schemas as TypeScript types", () => {
  it("types objects with required, optional and documented properties", () => {
    expect(
      typeOf({
        type: "object",
        properties: {
          id: { type: "string", description: "Issue ID" },
          limit: { type: "integer", maximum: 250 },
          "x-key": { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      }),
    ).toBe(
      '{\n  /**\n   * Issue ID\n   */\n  id: string;\n  limit?: number;\n  "x-key"?: boolean;\n}',
    );
    expect(typeOf({ type: "object", properties: {}, additionalProperties: false })).toBe(
      "Record<string, never>",
    );
  });

  it("types enums, constants, nullable values, unions and arrays", () => {
    expect(typeOf({ type: "string", enum: ["createdAt", "updatedAt"] })).toBe(
      '"createdAt" | "updatedAt"',
    );
    expect(typeOf({ type: "string", const: "replace" })).toBe('"replace"');
    expect(typeOf({ type: ["string", "null"] })).toBe("string | null");
    expect(
      typeOf({
        anyOf: [{ type: "string", format: "date-time", pattern: "^x$" }, { type: "null" }],
      }),
    ).toBe("string | null");
    expect(typeOf({ type: "array", items: { type: ["string", "null"] }, minItems: 1 })).toBe(
      "(string | null)[]",
    );
    expect(typeOf({ type: "array" })).toBe("Json[]");
  });

  it("types open objects as JSON values", () => {
    expect(
      typeOf({ type: "object", propertyNames: { type: "string" }, additionalProperties: {} }),
    ).toBe("{\n  [key: string]: Json;\n}");
    expect(typeOf({ type: "object", additionalProperties: { type: "number" } })).toBe(
      "{\n  [key: string]: number;\n}",
    );
    expect(typeOf({})).toBe("Json");
  });

  it("rejects keywords it cannot type", () => {
    expect(() => typeOf({ type: "object", allOf: [] })).toThrow();
    expect(() => typeOf({ $ref: "#/$defs/issue" })).toThrow();
    expect(() => typeOf({ type: "date" })).toThrow();
  });

  it("names methods and defaults inputs without required properties", () => {
    expect(methodName("list_issues")).toBe("listIssues");
    expect(methodName("save_diff_comment")).toBe("saveDiffComment");
    expect(optionalInput(jsonSchema.parse({ type: "object", required: [] }))).toBe(true);
    expect(optionalInput(jsonSchema.parse({ type: "object", required: ["id"] }))).toBe(false);
  });

  it("keeps descriptions from ending a comment early", () => {
    expect(comment("Use a/*b*/c", "")).toBe("/**\n * Use a/*b*\\/c\n */\n");
  });
});
