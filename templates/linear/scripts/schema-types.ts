// Turns the JSON Schemas of Linear's tools into TypeScript parameter types.
// It covers the subset Linear's schemas use and rejects anything else, so a
// new kind of schema fails generation instead of producing a wrong type.
import { z } from "zod";

const primitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const typeName = z.enum(["string", "number", "integer", "boolean", "null", "array", "object"]);

/** The JSON Schema keywords Linear's tool schemas use. */
export type JsonSchema = {
  $schema?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  default?: z.infer<ReturnType<typeof z.json>> | undefined;
  type?: z.infer<typeof typeName> | z.infer<typeof typeName>[] | undefined;
  enum?: z.infer<typeof primitive>[] | undefined;
  const?: z.infer<typeof primitive> | undefined;
  anyOf?: JsonSchema[] | undefined;
  oneOf?: JsonSchema[] | undefined;
  items?: JsonSchema | undefined;
  properties?: Record<string, JsonSchema> | undefined;
  required?: string[] | undefined;
  additionalProperties?: boolean | JsonSchema | undefined;
  propertyNames?: JsonSchema | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  exclusiveMinimum?: number | undefined;
  exclusiveMaximum?: number | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  format?: string | undefined;
  pattern?: string | undefined;
};

// Unknown keywords fail parsing, so the generator never ignores a constraint
// that changes a type. Numeric and format keywords only narrow values; runtime
// validation checks them with the complete schema.
export const jsonSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z.strictObject({
    $schema: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.json().optional(),
    type: z.union([typeName, z.array(typeName).min(1)]).optional(),
    enum: z.array(primitive).min(1).optional(),
    const: primitive.optional(),
    anyOf: z.array(jsonSchema).min(1).optional(),
    oneOf: z.array(jsonSchema).min(1).optional(),
    items: jsonSchema.optional(),
    properties: z.record(z.string(), jsonSchema).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.union([z.boolean(), jsonSchema]).optional(),
    propertyNames: jsonSchema.optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    exclusiveMinimum: z.number().optional(),
    exclusiveMaximum: z.number().optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    format: z.string().optional(),
    pattern: z.string().optional(),
  }),
);

const union = (types: string[]) => {
  const unique = [...new Set(types)];

  return unique.length === 1 ? (unique[0] ?? "never") : unique.join(" | ");
};

const grouped = (type: string) => (type.includes(" | ") ? `(${type})` : type);

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A JSDoc comment for generated code; `*\/` cannot end it early. */
export const comment = (text: string, indent: string) => {
  const lines = text.replaceAll("*/", "*\\/").trim().split("\n");

  return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
};

const objectType = (schema: JsonSchema, indent: string) => {
  const required = new Set(schema.required ?? []);
  const inner = `${indent}  `;
  const members: string[] = [];

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const key = identifier.test(name) ? name : JSON.stringify(name);
    const optional = required.has(name) ? "" : "?";

    members.push(
      `${property.description ? comment(property.description, inner) : ""}${inner}${key}${optional}: ${schemaType(property, inner)};\n`,
    );
  }

  const additional = schema.additionalProperties;

  // Other keys are allowed. Their values are JSON unless a schema narrows them
  // and no declared property needs a different type.
  if (additional === true || (additional !== undefined && additional !== false)) {
    const value =
      additional !== true && !members.length && Object.keys(additional).length
        ? schemaType(additional, inner)
        : "Json";

    members.push(`${inner}[key: string]: ${value};\n`);
  }

  return members.length ? `{\n${members.join("")}${indent}}` : "Record<string, never>";
};

const singleType = (type: z.infer<typeof typeName>, schema: JsonSchema, indent: string) => {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return schema.items ? `${grouped(schemaType(schema.items, indent))}[]` : "Json[]";
    case "object":
      return objectType(schema, indent);
  }
};

/** The TypeScript type of the values a JSON Schema accepts. */
export const schemaType = (schema: JsonSchema, indent = ""): string => {
  if (schema.const !== undefined) return JSON.stringify(schema.const);

  if (schema.enum) return union(schema.enum.map((value) => JSON.stringify(value)));

  const options = schema.anyOf ?? schema.oneOf;

  if (options) return union(options.map((option) => schemaType(option, indent)));

  if (schema.type === undefined) return "Json";

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];

  return union(types.map((type) => singleType(type, schema, indent)));
};

/** Whether no property of an object schema is required, so its input can default to `{}`. */
export const optionalInput = (schema: JsonSchema) => !schema.required?.length;

/** A tool name as a method name: `list_issues` becomes `listIssues`. */
export const methodName = (tool: string) =>
  tool.replace(/[_.-]+([a-zA-Z0-9])/g, (_, next: string) => next.toUpperCase());
