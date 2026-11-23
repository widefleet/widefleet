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

// The `$args` a field's selection passes, if any.
const argumentsSelected = (value: JsonValue | undefined) => {
  const nested = selection.safeParse(value);

  return nested.success ? (own(nested.data, "$args") ?? null) : null;
};

// JSON text with object keys in order, so equal values compare equal.
const canonical = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = selection.safeParse(value);

  if (!object.success) return JSON.stringify(value);

  return `{${Object.keys(object.data)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonical(own(object.data, key) ?? null)}`)
    .join(",")}}`;
};

// Selections from callers may leave optional values undefined, as JSON does.
const definedSelection = (select: FieldSelection | undefined) =>
  selection.safeParse(select === undefined ? undefined : definedJson.safeParse(select).data);

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

// Two selections of one field, such as a field selected for every type and in
// `... on Variant`, each return some of its fields: the result holds them together.
const merge = (left: JsonValue | undefined, right: JsonValue): JsonValue => {
  if (left === undefined) return right;

  if (Array.isArray(left) && Array.isArray(right))
    return right.map((entry, index) => merge(left[index], entry));
  const leftObject = selection.safeParse(left);
  const rightObject = selection.safeParse(right);

  if (!leftObject.success || !rightObject.success) return right;
  const merged = { ...leftObject.data };

  for (const [key, entry] of Object.entries(rightObject.data))
    merged[key] = merge(own(merged, key), entry);

  return merged;
};

// Reads the fields a selection names from one object of the response, under the
// alias `field__on__Variant` inside `... on Variant`. Values of JSON fields stay
// as the provider returned them.
const collect = (
  type: string,
  chosen: Selection,
  variant: string | undefined,
  object: Selection,
  result: Record<string, JsonValue>,
) => {
  const known = fieldsOf(type) ?? {};

  for (const [name, nestedSelection] of Object.entries(chosen)) {
    if (name === "$args") continue;

    if (name === "$on") {
      const typename = z.string().safeParse(own(object, "__typename"));
      const variants = selection.safeParse(nestedSelection);

      const fields =
        variants.success && typename.success ? own(variants.data, typename.data) : undefined;

      const variantFields = selection.safeParse(fields);

      if (typename.success && variantFields.success)
        collect(typename.data, variantFields.data, typename.data, object, result);
      continue;
    }

    const entry = own(object, variant ? `${name}${aliasSeparator}${variant}` : name);

    if (entry === undefined) continue;
    const [target] = own<Field>(known, name) ?? [];
    const nested = selection.safeParse(nestedSelection);

    result[name] = merge(
      own(result, name),
      target !== undefined && fieldsOf(target) && nested.success
        ? restored(target, nested.data, entry)
        : entry,
    );
  }

  const typename = own(object, "__typename");

  if (typename !== undefined) result["__typename"] = typename;
};

const restored = (type: string, chosen: Selection, value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map((entry) => restored(type, chosen, entry));
  const object = selection.safeParse(value);

  if (!object.success) return value;
  const result: Record<string, JsonValue> = {};
  collect(type, chosen, undefined, object.data, result);

  return result;
};

/**
 * A query's or mutation's result with the field names its selection used:
 * `state__on__Issue` is `state` again.
 */
export const graphqlResult = (
  root: "Query" | "Mutation",
  field: string,
  select: FieldSelection | undefined,
  value: JsonValue,
): JsonValue => {
  const [target = ""] = own<Field>(fieldsOf(root) ?? {}, field) ?? [];
  const chosen = definedSelection(select);

  return fieldsOf(target) && chosen.success ? restored(target, chosen.data, value) : value;
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
  // only accepts under different names. graphqlResult undoes it in the result.
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

            // The result holds both selections of a field in one object, so they
            // must select the same thing.
            for (const [field, fieldValue] of Object.entries(variantFields)) {
              const shared = own(chosen, field);

              if (
                field !== "$args" &&
                field !== "$on" &&
                shared !== undefined &&
                canonical(argumentsSelected(shared)) !== canonical(argumentsSelected(fieldValue))
              )
                throw new InvalidRequest(
                  `${type}.${field} and ${variant}.${field} in $on need the same $args`,
                );
            }

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
    const chosen = definedSelection(select);

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
