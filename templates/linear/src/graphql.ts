import { z } from "zod";
import type { JsonValue } from "./selection.ts";
import { type Graph, graph, variants } from "./schema.ts";

/** Linear's GraphQL API. */
export const linearApi = "https://api.linear.app/graphql";

const json = z.json();

const identifier = z.string().regex(/^[_A-Za-z][_0-9A-Za-z]*$/);

// Selections arrive from apps and agents as JSON: field names map to `true` or
// to a nested selection, which may carry `$args` and `$on`.
const selection = z.record(z.string(), json);

type Selection = z.infer<typeof selection>;

// JSON values, leaving out undefined object fields at every depth as JSON does.
// Numbers must be finite: NaN or Infinity never turn into null.
export const definedJson: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(definedJson),
    z
      .record(z.string(), definedJson.optional())
      .transform((entries) =>
        Object.fromEntries(
          Object.entries(entries).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, value] as const],
          ),
        ),
      ),
  ]),
);

const argumentValues = z.record(z.string(), definedJson.optional());

// A field's value in a selection: `true`, or the nested selection.
const nestedSelection = (owner: string, value: JsonValue | undefined) => {
  if (value === true) return true;
  const nested = selection.safeParse(value);

  if (!nested.success) throw new InvalidRequest(`Select ${owner} with true or an object`);

  return nested.data;
};

type Fields = Graph[string];

type Field = Fields[string];

// Own properties only: names in a selection come from callers.
const own = <T>(record: Record<string, T>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const fieldsOf = (type: string) => own<Fields>(graph, type);

/** A selection or input that does not match Linear's schema. */
export class InvalidRequest extends Error {}

export type GraphQLRequest = { query: string; variables: Record<string, JsonValue> };

/** JSON as typed inputs and selections hold it, where optional fields may be undefined. */
export type JsonInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonInput[]
  | { readonly [key: string]: JsonInput };

/** A method's arguments by name, as its generated signature types them. */
export type Arguments = Readonly<Record<string, JsonInput>>;

/** The fields to return, as `Selection` types them. */
export type FieldSelection = Readonly<Record<string, JsonInput>>;

/**
 * Writes the GraphQL request for one query or mutation. Every argument travels
 * as a variable with the type Linear's schema declares for it.
 */
export const graphqlRequest = (
  root: "Query" | "Mutation",
  field: string,
  input: Arguments,
  select?: FieldSelection,
): GraphQLRequest => {
  const variables: Record<string, JsonValue> = {};
  const declarations: string[] = [];

  const argumentsOf = (owner: string, types: Record<string, string>, values: JsonInput) => {
    const parsed = argumentValues.safeParse(values ?? {});

    if (!parsed.success)
      throw new InvalidRequest(
        `Arguments of ${owner} must be JSON: ${z.prettifyError(parsed.error)}`,
      );

    const written = Object.entries(parsed.data).flatMap(([name, value]) => {
      const type = own(types, name);

      if (value === undefined) return [];

      if (!type) throw new InvalidRequest(`${owner} has no argument ${name}`);
      const variable = `v${declarations.length}`;
      declarations.push(`$${variable}: ${type}`);
      variables[variable] = value;

      return [`${name}: $${variable}`];
    });

    return written.length ? `(${written.join(", ")})` : "";
  };

  const fields = (type: string, chosen: Selection): string => {
    const known = fieldsOf(type) ?? {};

    const written = Object.entries(chosen).flatMap(([name, value]) => {
      if (name === "$args") return [];
      const nested = nestedSelection(`${type}.${name}`, value);

      if (name === "$on") {
        if (nested === true) throw new InvalidRequest(`$on of ${type} selects types by name`);

        return [
          "__typename",
          ...Object.entries(nested).map(([variant, variantValue]) => {
            const variantFields = nestedSelection(`${type} on ${variant}`, variantValue);

            if (
              !identifier.safeParse(variant).success ||
              !fieldsOf(variant) ||
              variantFields === true
            )
              throw new InvalidRequest(`$on of ${type} names no type ${variant}`);

            return `... on ${variant} { ${fields(variant, variantFields)} }`;
          }),
        ];
      }

      if (!identifier.safeParse(name).success)
        throw new InvalidRequest(`${type} has no field ${name}`);
      const [target, types = {}] = own<Field>(known, name) ?? [];

      // Fields Linear's schema does not know reach Linear, which names them in its error.
      if (target === undefined || !fieldsOf(target)) {
        if (nested === true) return [name];

        return [`${name}${argumentsOf(`${type}.${name}`, types, nested["$args"])}`];
      }

      if (nested === true)
        throw new InvalidRequest(`Select fields of ${target} for ${type}.${name}`);

      return [
        `${name}${argumentsOf(`${type}.${name}`, types, nested["$args"])} { ${fields(target, nested)} }`,
      ];
    });

    if (!written.length) throw new InvalidRequest(`Select at least one field of ${type}`);

    // The result type of a union or interface promises its concrete type.
    if (variants.has(type) && !written.includes("__typename")) written.unshift("__typename");

    return written.join(" ");
  };

  const [target = "", types = {}] = own<Field>(fieldsOf(root) ?? {}, field) ?? [];
  const call = `${field}${argumentsOf(field, types, input)}`;

  let body = call;

  if (fieldsOf(target)) {
    const chosen = selection.safeParse(select);

    if (!chosen.success) throw new InvalidRequest(`${field} needs a selection of ${target} fields`);
    body = `${call} { ${fields(target, chosen.data)} }`;
  }

  const operation = root === "Query" ? "query" : "mutation";
  const signature = declarations.length ? `(${declarations.join(", ")})` : "";

  return { query: `${operation}${signature} { ${body} }`, variables };
};

const graphqlError = z.object({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  extensions: z
    .object({ type: z.string().optional(), userPresentableMessage: z.string().optional() })
    .optional(),
});

export const graphqlResponse = z.object({
  data: z.record(z.string(), json).nullable().optional(),
  errors: z.array(graphqlError).optional(),
});

/** Linear's errors, with the message Linear writes for people where it has one. */
export const linearErrors = (errors: z.infer<typeof graphqlError>[]) =>
  errors.map((error) => ({
    message: error.extensions?.userPresentableMessage ?? error.message,
    type: error.extensions?.type ?? null,
    path: error.path ?? null,
  }));
