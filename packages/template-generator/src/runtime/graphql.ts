// Shared by the generated GraphQL templates: the template generator copies this
// file into each template's src. Edit it in packages/template-generator/src/runtime.
import { z } from "zod";
import {
  type Arguments,
  definedJson,
  type FieldSelection,
  InvalidRequest,
  type JsonInput,
} from "./input.ts";
import type { JsonValue } from "./selection.ts";
import { type Graph, graph, variants } from "./schema.ts";

const json = z.json();

const identifier = z.string().regex(/^[_A-Za-z][_0-9A-Za-z]*$/);

// Selections arrive from apps and agents as JSON: field names map to `true` or
// to a nested selection, which may carry `$args` and `$on`.
const selection = z.record(z.string(), json);

type Selection = z.infer<typeof selection>;

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

const aliasSeparator = "__on__";

const aliased = /^(.+)__on__([_A-Za-z][_0-9A-Za-z]*)$/;

/** A result with the names its selection used: `state__on__Issue` is `state` again. */
export const restoreAliases = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(restoreAliases);
  const object = selection.safeParse(value);

  if (!object.success) return value;

  return Object.fromEntries(
    Object.entries(object.data).map(([key, entry]) => [
      aliased.exec(key)?.[1] ?? key,
      restoreAliases(entry),
    ]),
  );
};

export type GraphQLRequest = { query: string; variables: Record<string, JsonValue> };

/**
 * Writes the GraphQL request for one query or mutation. Every argument travels
 * as a variable with the type the provider's schema declares for it.
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

  // Fields inside `... on Variant` take the alias `field__on__Variant`: two
  // variants may have a field of one name with different types, which GraphQL
  // only accepts under different names. restoreAliases undoes it in the result.
  const fields = (type: string, chosen: Selection, variant?: string): string => {
    const named = (name: string) =>
      variant ? `${name}${aliasSeparator}${variant}: ${name}` : name;

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

            return `... on ${variant} { ${fields(variant, variantFields, variant)} }`;
          }),
        ];
      }

      if (!identifier.safeParse(name).success)
        throw new InvalidRequest(`${type} has no field ${name}`);
      const [target, types = {}] = own<Field>(known, name) ?? [];

      // Fields the schema does not know reach the provider, which names them in its error.
      if (target === undefined || !fieldsOf(target)) {
        if (nested === true) return [named(name)];

        return [`${named(name)}${argumentsOf(`${type}.${name}`, types, nested["$args"])}`];
      }

      if (nested === true)
        throw new InvalidRequest(`Select fields of ${target} for ${type}.${name}`);

      return [
        `${named(name)}${argumentsOf(`${type}.${name}`, types, nested["$args"])} { ${fields(target, nested)} }`,
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

// Providers add their own details, in `extensions` or as further fields such as `type`.
const graphqlError = z.looseObject({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  type: z.string().optional(),
  extensions: z.record(z.string(), json).optional(),
});

/** One error of a GraphQL response. */
export type GraphQLError = z.infer<typeof graphqlError>;

export const graphqlResponse = z.object({
  data: z.record(z.string(), json).nullable().optional(),
  errors: z.array(graphqlError).optional(),
});
