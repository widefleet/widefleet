// Generates a template's typed API from a GraphQL schema: one method per query
// and mutation, with typed inputs, selections and results. The template's rules
// decide how each operation is offered.
import {
  buildSchema,
  getNamedType,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from "graphql";
import { z } from "zod";
import { checkTypeNames, comment } from "./emit.ts";
import { reservedMethods } from "./reserved.ts";
import type { Change, GeneratedFiles, Hidden } from "./rules.ts";

/** How a GraphQL template offers its operations. */
export interface GraphqlRules {
  /** Every mutation, with the change it makes or why it is not offered. */
  mutations: Record<string, Change | Hidden>;
  /** Queries that are not offered or are renamed; all others are offered. */
  queries: Record<string, Hidden | { name: string }>;
}

/** The names the generated code uses for the template's service. */
export interface GraphqlService {
  /** The service's name in documentation, such as `Linear`. */
  name: string;
  /** The generated entrypoint class, such as `LinearApi`. */
  className: string;
  /** The result type in `src/results.ts`, such as `LinearResult`. */
  result: string;
  /** The props type in `src/run.ts`, such as `LinearProperties`. */
  properties: string;
}

export const generateGraphql = (
  sdl: string,
  { mutations, queries }: GraphqlRules,
  service: GraphqlService,
  header: string,
): GeneratedFiles => {
  const schema = buildSchema(sdl);

  const query = z
    .custom<NonNullable<ReturnType<typeof schema.getQueryType>>>()
    .parse(schema.getQueryType());

  const mutation = z
    .custom<NonNullable<ReturnType<typeof schema.getMutationType>>>()
    .parse(schema.getMutationType());

  const roots = new Set<GraphQLNamedType>([query, mutation]);

  const changes = z.enum(["create", "update", "delete", "send"]);

  const hiddenRule = z.object({ hidden: z.string() });

  const queryRules = new Map<string, { hidden: string } | { name: string }>(
    Object.entries(queries),
  );

  const mutationRules = new Map<string, string | { hidden: string }>(Object.entries(mutations));

  const scalars = new Map([
    ["Int", "number"],
    ["Float", "number"],
    ["Boolean", "boolean"],
    ["JSON", "JsonValue"],
    ["JSONObject", "JsonObject"],
  ]);

  const typeName = (type: GraphQLNamedType) =>
    isScalarType(type) ? (scalars.get(type.name) ?? "string") : type.name;

  // TypeScript for a GraphQL type without its own nullability.
  const value = (type: GraphQLOutputType | GraphQLInputType): string => {
    if (isNonNullType(type)) return value(type.ofType);

    if (isListType(type)) {
      const item = isNonNullType(type.ofType)
        ? value(type.ofType.ofType)
        : `${value(type.ofType)} | null`;

      return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
    }

    return typeName(type);
  };

  const nullable = (type: GraphQLOutputType | GraphQLInputType) =>
    isNonNullType(type) ? value(type) : `${value(type)} | null`;

  const offered = <T extends { deprecationReason?: string | null | undefined }>(
    items: readonly T[],
  ) => items.filter((item) => !item.deprecationReason);

  // Arguments and input fields may be left out when they are nullable or have a
  // default; an explicit null clears a nullable value.
  const inputs = (
    fields: readonly Pick<GraphQLArgument, "name" | "description" | "type" | "defaultValue">[],
    indent: string,
  ) =>
    `{\n${fields
      .map(
        (field) =>
          `${comment(field.description, `${indent}  `)}${indent}  ${field.name}${isNonNullType(field.type) && field.defaultValue === undefined ? "" : "?"}: ${nullable(field.type)};`,
      )
      .join("\n")}\n${indent}}`;

  const required = (args: readonly GraphQLArgument[]) =>
    args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined);

  const implementations = new Map<string, string[]>();

  for (const type of Object.values(schema.getTypeMap()))
    if (isObjectType(type) && !roots.has(type))
      for (const parent of type.getInterfaces())
        implementations.set(parent.name, [...(implementations.get(parent.name) ?? []), type.name]);

  const fieldsOf = (type: GraphQLNamedType) =>
    isObjectType(type) || isInterfaceType(type)
      ? offered(Object.values(type.getFields())).filter(
          (field) => !roots.has(getNamedType(field.type)),
        )
      : [];

  // The GraphQL type of each argument, which a request declares for its variables.
  const argumentTypes = (args: readonly GraphQLArgument[]) =>
    Object.fromEntries(offered(args).map((arg) => [arg.name, arg.type.toString()]));

  let models = "";

  // What the runtime needs to write a request: each field's type when it is an
  // object, and the types of its arguments.
  const graph: Record<string, Record<string, [string] | [string, Record<string, string>]>> = {};

  const variantNames: string[] = [];

  const named = Object.values(schema.getTypeMap())
    .filter((type) => !type.name.startsWith("__") && !isScalarType(type) && !roots.has(type))
    .toSorted((left, right) => left.name.localeCompare(right.name, "en"));

  checkTypeNames(
    named.map((type) => type.name),
    service,
  );

  for (const type of named) {
    if (isEnumType(type)) {
      // Deprecated values stay: results can still carry them.
      const values = type.getValues().map((entry) => JSON.stringify(entry.name));
      models += `${comment(type.description)}export type ${type.name} = ${values.join(" | ") || "never"};\n\n`;
      continue;
    }

    if (isUnionType(type) || isInterfaceType(type)) variantNames.push(type.name);

    if (isUnionType(type)) {
      models += `${comment(type.description)}export interface ${type.name} extends Variants<${type
        .getTypes()
        .map((member) => member.name)
        .join(" | ")}> {}\n\n`;
      graph[type.name] = {};
      continue;
    }

    if (isInputObjectType(type)) {
      // A type alias, not an interface, so inputs are JSON values for TypeScript too.
      models += `${comment(type.description)}export type ${type.name} = ${inputs(offered(Object.values(type.getFields())), "")};\n\n`;
      continue;
    }

    const variants = isInterfaceType(type)
      ? ` extends Variants<${(implementations.get(type.name) ?? []).join(" | ") || "never"}>`
      : "";

    const members = fieldsOf(type).map((field) => {
      const args = offered(field.args);
      const result = nullable(field.type);

      // A field with arguments is written as a method, so a selection passes them as `$args`.
      const member = args.length
        ? `${field.name}(args${required(args) ? "" : "?"}: ${inputs(args, "  ")}): ${result};`
        : `${field.name}: ${result};`;

      return `${comment(field.description, "  ")}  ${member}`;
    });

    if (isObjectType(type)) members.unshift(`  __typename: ${JSON.stringify(type.name)};`);
    models += `${comment(type.description)}export interface ${type.name}${variants} {\n${members.join("\n")}\n}\n\n`;

    graph[type.name] = Object.fromEntries(
      fieldsOf(type).flatMap((field) => {
        const target = getNamedType(field.type);
        const args = argumentTypes(field.args);

        if (isLeafType(target) && !Object.keys(args).length) return [];

        return [[field.name, Object.keys(args).length ? [target.name, args] : [target.name]]];
      }),
    );
  }

  const reserved = new Set(reservedMethods);

  const problems: string[] = [];

  const methods: string[] = [];

  const names = new Set<string>();

  const offer = (
    root: "Query" | "Mutation",
    field: GraphQLField<unknown, unknown>,
    name: string,
    change: Change | null,
  ) => {
    if (reserved.has(name) || names.has(name))
      return problems.push(`${root}.${field.name} becomes method ${name}, which is taken`);
    names.add(name);
    graph[root] = {
      ...graph[root],
      [field.name]: [getNamedType(field.type).name, argumentTypes(field.args)],
    };

    const args = offered(field.args);
    const input = args.length ? inputs(args, "  ") : "Record<string, never>";
    const result = nullable(field.type);
    const target = getNamedType(field.type);
    const operation = `{ root: ${JSON.stringify(root)}, field: ${JSON.stringify(field.name)}, change: ${JSON.stringify(change)} }`;

    const approval =
      change === null
        ? ""
        : change === "create"
          ? "Asks the user first when their approval level is `all_changes`."
          : "Asks the user first unless their approval level is `none`.";

    // Declaration comments on inline input types do not reach describe, so the
    // arguments are described on the parameter.
    const argumentDocs = args.map(
      (arg) =>
        `- \`${arg.name}\`${arg.description ? `: ${arg.description.replace(/\s*\n\s*/g, " ")}` : ""}`,
    );

    const tags = [
      args.length
        ? `@param input - The arguments:\n${argumentDocs.join("\n")}`
        : "@param input - No arguments: pass `{}`.",
      isLeafType(target) ? "" : `@param select - The fields of \`${target.name}\` to return.`,
    ].filter(Boolean);

    const description = comment(
      [field.description, approval, tags.join("\n")].filter(Boolean).join("\n\n"),
      "  ",
    );

    methods.push(
      isLeafType(target)
        ? `${description}  async ${name}(input: ${input}): Promise<${service.result}<${result}>> {\n    return run(this.env, this.ctx.props, ${operation}, input);\n  }\n`
        : `${description}  async ${name}<S extends Selection<${target.name}>>(input: ${input}, select: S & Exact<S, Selection<${target.name}>>): Promise<${service.result}<ValueResult<${result}, S>>> {\n    return run(this.env, this.ctx.props, ${operation}, input, select);\n  }\n`,
    );

    return undefined;
  };

  const queryFields = offered(Object.values(query.getFields()));

  const mutationFields = offered(Object.values(mutation.getFields()));

  for (const name of Object.keys(queries))
    if (!queryFields.some((field) => field.name === name))
      problems.push(`The rules list query ${name}, which the schema no longer offers`);

  for (const name of Object.keys(mutations))
    if (!mutationFields.some((field) => field.name === name))
      problems.push(`The rules list mutation ${name}, which the schema no longer offers`);

  for (const field of queryFields) {
    const rule = queryRules.get(field.name);

    if (rule && "hidden" in rule) continue;
    offer("Query", field, rule?.name ?? field.name, null);
  }

  for (const field of mutationFields) {
    const rule = mutationRules.get(field.name);

    if (!rule) {
      problems.push(
        `Mutation ${field.name} is new; add it to the rules: ${field.description ?? ""}`,
      );
      continue;
    }

    const change = changes.safeParse(rule);

    if (change.success) offer("Mutation", field, field.name, change.data);
  }

  if (problems.length) throw new Error(problems.join("\n"));

  const hidden = [...Object.values(queries), ...Object.values(mutations)].filter(
    (rule) => hiddenRule.safeParse(rule).success,
  ).length;

  // Types and method signatures both may use the JSON types.
  const uses = (name: string) => new RegExp(`\\b${name}\\b`).test(models + methods.join(""));

  return {
    files: {
      "src/api.ts": `${header}import { WorkerEntrypoint } from "cloudflare:workers";
import type { Environment as TemplateEnvironment } from "./context.ts";
import type { ${service.result} } from "./results.ts";
import { type ${service.properties}, run } from "./run.ts";
import type { Exact, ${["JsonObject", "JsonValue"]
        .flatMap((used) => (uses(used) ? [`${used}, `] : []))
        .join(
          "",
        )}Selection, ValueResult${uses("Variants") ? ", Variants" : ""} } from "./selection.ts";

${models}/**
 * Every query and mutation of ${service.name}'s GraphQL API that a user's token can use,
 * as a method. A query reads; a mutation changes data and may ask the user first.
 * Methods returning objects take a selection of the fields to return.
 */
export class ${service.className} extends WorkerEntrypoint<TemplateEnvironment, ${service.properties}> {
${methods.join("\n")}}
`,
      "src/schema.ts": `${header}
/**
 * For each object type, the fields that return objects or take arguments: the
 * field's type and the GraphQL types of its arguments.
 */
export type Graph = Record<string, Record<string, [string] | [string, Record<string, string>]>>;

export const graph = ${JSON.stringify(graph)} satisfies Graph;

/** Unions and interfaces, whose results always carry \`__typename\`. */
export const variants = new Set(${JSON.stringify(variantNames)});
`,
    },
    summary: `${methods.length} methods, ${hidden} operations not offered, ${named.length} types`,
  };
};
