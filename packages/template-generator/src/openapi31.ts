// Reads OpenAPI 3.1 schemas as the OpenAPI 3.0 schemas the generator reads.
// OpenAPI 3.1 follows JSON Schema: a nullable value lists `null` among its
// types, as `type: [string, "null"]`, and a fixed value is a `const`. Qonto's
// description writes both. The upgrade rewrites them outside literal data,
// such as examples, and leaves the rest of the description as it is.
import { z } from "zod";
import { holdsNames, type Json, jsonEntries, type JsonObject, literalData } from "./rules.ts";

// A list of types, or the null type alone, which 3.0 has no type for.
const typeList = z.union([
  z.array(z.string()).min(1),
  z.literal("null").transform((type) => [type]),
]);

const literal = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// Keywords that apply to values of one type, which a union's branch for that type keeps.
const typeKeywords = new Map([
  ["array", ["items", "minItems", "maxItems", "uniqueItems"]],
  ["object", ["properties", "additionalProperties", "required", "minProperties", "maxProperties"]],
  ["string", ["format", "pattern", "minLength", "maxLength"]],
  ["number", ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]],
  [
    "integer",
    ["format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  ],
]);

// A schema's types as 3.0 writes them: one type, or a union of them, either
// nullable. A schema whose only type is `null` holds the null value alone. In a
// union, each branch keeps the keywords for its type, such as an array's items.
const typed = (schema: JsonObject, listed: string[]): JsonObject => {
  const { type: _, ...rest } = schema;
  const others = listed.filter((entry) => entry !== "null");
  const nullable = others.length < listed.length ? { nullable: true } : {};
  const [only] = others;

  if (only === undefined) return { ...rest, enum: [null] };

  if (others.length === 1) return { ...rest, type: only, ...nullable };

  const specific = new Set([...typeKeywords.values()].flat());

  const branch = (type: string) => ({
    type,
    ...Object.fromEntries(
      Object.entries(rest).filter(([key]) => typeKeywords.get(type)?.includes(key)),
    ),
  });

  return {
    ...Object.fromEntries(Object.entries(rest).filter(([key]) => !specific.has(key))),
    anyOf: others.map(branch),
    ...nullable,
  };
};

// A fixed value is an enum of that value.
const fixed = (schema: JsonObject): JsonObject => {
  const value = literal.safeParse(schema["const"]);

  if (!value.success || schema["enum"] !== undefined) return schema;
  const { const: _, ...rest } = schema;

  return { ...rest, enum: [value.data] };
};

// `names` is whether the value maps names to values, such as a schema's
// properties, whose keys are never keywords.
const upgraded = (value: Json, names: boolean): Json => {
  if (Array.isArray(value)) return value.map((entry) => upgraded(entry, false));
  const entries = jsonEntries(value);

  if (!entries) return value;

  const result = Object.fromEntries(
    entries.map(([key, entry]) => [
      key,
      !names && literalData(key, null) ? entry : upgraded(entry, !names && holdsNames(key)),
    ]),
  );

  if (names) return result;
  const listed = typeList.safeParse(result["type"]);
  const schema = fixed(result);

  return listed.success ? typed(schema, listed.data) : schema;
};

/** Whether a parsed description is an OpenAPI 3.1 document. */
export const isOpenapi31 = (description: Json) =>
  z.object({ openapi: z.string().startsWith("3.1.") }).safeParse(description).success;

/** The OpenAPI 3.0 form of an OpenAPI 3.1 description's schemas. */
export const upgradeOpenapi31 = (description: Json): Json => upgraded(description, false);
