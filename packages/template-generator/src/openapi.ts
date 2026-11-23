// Generates a template's typed API from an OpenAPI 3 description: one method
// per offered operation, with typed inputs and results. Large APIs, such as
// Microsoft Graph, describe far more than one template offers, so the
// template's rules list the operations it offers by operation ID, each with
// its method name and, for operations that are not GET, the change it makes.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { checkTypeNames, comment, identifier, propertyName } from "./emit.ts";
import { reservedMethods } from "./reserved.ts";
import type { Change, GeneratedFiles } from "./rules.ts";

/** How an OpenAPI template offers operations. */
export interface OpenapiRules {
  /**
   * Offered operations by operation ID, such as `drives.items.ListChildren`, with
   * the method name and, for every operation that is not a GET, its change.
   */
  operations: Record<string, { name: string; change?: Change | undefined }>;
}

/** The names the generated code uses for the template's service. */
export interface OpenapiService {
  /** The service's name in documentation, such as `OneDrive`. */
  name: string;
  /** The generated entrypoint class, such as `OneDriveApi`. */
  className: string;
  /** The result type in `src/results.ts`, such as `OneDriveResult`. */
  result: string;
  /** The props type in `src/run.ts`, such as `OneDriveProperties`. */
  properties: string;
  /** A prefix of the API's schema names that type names leave out, such as `microsoft.graph.`. */
  typePrefix?: string | undefined;
}

interface Schema {
  $ref?: string | undefined;
  type?: string | undefined;
  format?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  nullable?: boolean | undefined;
  enum?: (string | number | boolean | null)[] | undefined;
  items?: Schema | undefined;
  properties?: Record<string, Schema> | undefined;
  additionalProperties?: Schema | boolean | undefined;
  required?: string[] | undefined;
  allOf?: Schema[] | undefined;
  anyOf?: Schema[] | undefined;
  oneOf?: Schema[] | undefined;
  readOnly?: boolean | undefined;
  deprecated?: boolean | undefined;
  "x-ms-navigationProperty"?: boolean | undefined;
}

const schema: z.ZodType<Schema> = z.lazy(() =>
  z.looseObject({
    $ref: z.string().optional(),
    type: z.string().optional(),
    format: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    nullable: z.boolean().optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    items: schema.optional(),
    properties: z.record(z.string(), schema).optional(),
    additionalProperties: z.union([schema, z.boolean()]).optional(),
    required: z.array(z.string()).optional(),
    allOf: z.array(schema).optional(),
    anyOf: z.array(schema).optional(),
    oneOf: z.array(schema).optional(),
    readOnly: z.boolean().optional(),
    deprecated: z.boolean().optional(),
    "x-ms-navigationProperty": z.boolean().optional(),
  }),
);

const reference = z.object({ $ref: z.string() });

const parameter = z.looseObject({
  name: z.string(),
  in: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  style: z.string().optional(),
  explode: z.boolean().optional(),
  schema: schema.optional(),
  deprecated: z.boolean().optional(),
});

const content = z.record(z.string(), z.looseObject({ schema: schema.optional() }));

const response = z.looseObject({ description: z.string().optional(), content: content.optional() });

const requestBody = z.looseObject({
  description: z.string().optional(),
  required: z.boolean().optional(),
  content: content.optional(),
});

const operation = z.looseObject({
  operationId: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  parameters: z.array(z.union([reference, parameter])).optional(),
  requestBody: z.union([reference, requestBody]).optional(),
  responses: z.record(z.string(), z.union([reference, response])).optional(),
  deprecated: z.boolean().optional(),
  "x-ms-pageable": z.unknown().optional(),
});

const methods = ["get", "put", "post", "patch", "delete"] as const;

const pathItem = z.looseObject({
  parameters: z.array(z.union([reference, parameter])).optional(),
  ...Object.fromEntries(methods.map((method) => [method, operation.optional()])),
});

const document = z.looseObject({
  openapi: z.string().startsWith("3."),
  servers: z.array(z.object({ url: z.url() })).min(1),
  paths: z.record(z.string(), pathItem),
  components: z
    .looseObject({
      schemas: z.record(z.string(), schema).optional(),
      parameters: z.record(z.string(), parameter).optional(),
      responses: z.record(z.string(), response).optional(),
      requestBodies: z.record(z.string(), requestBody).optional(),
    })
    .optional(),
});

/** How the runtime calls one method: its HTTP request and the change it makes. */
export type OpenapiOperation = {
  httpMethod: string;
  path: string;
  /** Input names of path parameters, by the name the path uses. */
  pathParameters: Record<string, string>;
  /** Query parameters by input name: the API's name, and whether a list repeats it. */
  queryParameters: Record<string, [string, boolean]>;
  body: "json" | "text" | null;
  bodyRequired: boolean;
  response: "json" | "binary" | null;
  /** Whether the method continues at an earlier result's `@odata.nextLink`. */
  pageable: boolean;
  change: Change | null;
};

const changes = z.enum(["create", "update", "delete", "send"]);

// A parameter or body name as an input field: `drive-id` is `driveId`.
const inputName = (name: string) =>
  /^[A-Za-z_$][\w$]*$/.test(name)
    ? name
    : name.replace(/[^\w$]+(\w)?/g, (_, next?: string) => next?.toUpperCase() ?? "");

const queryParameter = (name: string, explode: boolean): [string, [string, boolean]] => [
  inputName(name),
  [name, explode],
];

const single = (text: string | undefined) => text?.replace(/\s*\n\s*/g, " ") ?? "";

export const generateOpenapi = (
  source: string,
  { operations }: OpenapiRules,
  service: OpenapiService,
  header: string,
): GeneratedFiles => {
  const text = source.trimStart();

  const api = document.parse(
    text.startsWith("{") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: -1 }),
  );

  const components = api.components ?? {};
  const schemas = components.schemas ?? {};

  // A parameter, response or request body, or the component its reference names.
  const resolve = <T>(
    value: { $ref: string } | T,
    section: "parameters" | "responses" | "requestBodies",
    kind: z.ZodType<T>,
  ): T => {
    const ref = reference.safeParse(value);

    if (!ref.success) return kind.parse(value);
    const name = ref.data.$ref.replace(`#/components/${section}/`, "");
    const found = components[section]?.[name];

    if (found === undefined) throw new Error(`${ref.data.$ref} is not described`);

    return kind.parse(found);
  };

  // Type names leave out the prefix the API gives every schema and join the
  // remaining parts: `microsoft.graph.driveItem` is `DriveItem`.
  const typeNames = new Map<string, string>();
  const takenTypes = new Map<string, string>();

  for (const key of Object.keys(schemas)) {
    const stripped =
      service.typePrefix && key.startsWith(service.typePrefix)
        ? key.slice(service.typePrefix.length)
        : key;

    const name = identifier(
      stripped
        .split(".")
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(""),
    );

    const other = takenTypes.get(name);

    if (other) throw new Error(`Schemas ${other} and ${key} both become type ${name}`);
    takenTypes.set(name, key);
    typeNames.set(key, name);
  }

  const referenced = new Set<string>();
  const pending: string[] = [];

  const typeName = (ref: string) => {
    const key = ref.replace("#/components/schemas/", "");
    const name = typeNames.get(key);

    if (!name) throw new Error(`${ref} is not described`);

    if (!referenced.has(key)) {
      referenced.add(key);
      pending.push(key);
    }

    return name;
  };

  const literal = (value: string | number | boolean | null) => JSON.stringify(value);

  // The members of a union, outside nested types.
  const members = (type: string) => {
    const parts = [""];
    let depth = 0;

    for (const character of type) {
      if ("{([<".includes(character)) depth++;
      else if ("})]>".includes(character)) depth--;

      if (depth === 0 && character === "|") parts.push("");
      else parts[parts.length - 1] += character;
    }

    return parts.map((part) => part.trim());
  };

  // Whether a type is a string literal or a schema of string values only.
  const stringValues = (type: string) => {
    if (/^"[^"]*"$/.test(type)) return true;
    const value = schemas[takenTypes.get(type) ?? ""];

    return value?.type === "string" && value.enum !== undefined;
  };

  // Parentheses for a union or intersection inside another type. Unions inside
  // an object type's fields need none.
  const wrap = (type: string) => {
    let depth = 0;

    for (const character of type) {
      if ("{([<".includes(character)) depth++;
      else if ("})]>".includes(character)) depth--;
      else if (depth === 0 && (character === "|" || character === "&")) return `(${type})`;
    }

    return type;
  };

  // Navigation properties are only returned when expanded, so the types leave
  // them out, as do deprecated properties.
  const typeOf = (value: Schema, indent: string): string => {
    const nullable = value.nullable ? " | null" : "";

    if (value.$ref) return `${typeName(value.$ref)}${nullable}`;

    if (value.allOf) {
      const parts = value.allOf.map((part) => wrap(typeOf(part, indent)));
      const own = value.properties ? [objectType(value, indent)] : [];

      return `${[...parts, ...own].join(" & ")}${nullable}`;
    }

    const variants = value.anyOf ?? value.oneOf;

    // Graph writes nullable references as `anyOf: [reference, nullable object]`.
    // A union with `string` needs none of the string values it also lists.
    if (variants) {
      const types = new Set(
        variants.flatMap((member) =>
          member.type === "object" && !member.properties && !member.$ref && member.nullable
            ? ["null"]
            : members(typeOf(member, indent)),
        ),
      );

      const union = [...types].filter(
        (type) =>
          type !== "null" && !(types.has("string") && type !== "string" && stringValues(type)),
      );

      return [...union, ...(types.has("null") || value.nullable ? ["null"] : [])].join(" | ");
    }

    if (value.enum) return `${value.enum.map(literal).join(" | ")}${nullable}`;

    switch (value.type) {
      case "integer":
      case "number":
        return `number${nullable}`;
      case "boolean":
        return `boolean${nullable}`;
      case "string":
        return `string${nullable}`;
      case "array": {
        return `${wrap(typeOf(value.items ?? {}, indent))}[]${nullable}`;
      }

      case "object":
        return `${objectType(value, indent)}${nullable}`;
      default:
        return value.properties ? objectType(value, indent) : "JsonValue";
    }
  };

  const describe = (value: Schema) =>
    [value.description, value.readOnly ? "Output only." : ""].filter(Boolean).join("\n\n");

  // Annotations such as OData's `@odata.type` are the server's to add.
  const objectType = (value: Schema, indent: string): string => {
    const required = new Set(value.required?.filter((name) => !name.startsWith("@")));

    const fields = Object.entries(value.properties ?? {})
      .filter(([, field]) => !field.deprecated && !field["x-ms-navigationProperty"])
      .map(
        ([name, field]) =>
          `${comment(describe(field), `${indent}  `)}${indent}  ${propertyName(name)}${required.has(name) ? "" : "?"}: ${typeOf(field, `${indent}  `)};`,
      );

    if (value.additionalProperties)
      fields.push(
        `${indent}  [key: string]: ${value.additionalProperties === true ? "JsonValue" : typeOf(value.additionalProperties, `${indent}  `)};`,
      );

    return fields.length ? `{\n${fields.join("\n")}\n${indent}}` : "JsonObject";
  };

  const all = Object.entries(api.paths).flatMap(([path, item]) =>
    methods.flatMap((method) => {
      const entry = operation.optional().parse(item[method]);

      return entry?.operationId ? [{ path, item, method, entry, id: entry.operationId }] : [];
    }),
  );

  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const problems: string[] = [];
  const reserved = new Set(reservedMethods);
  const names = new Set<string>();

  for (const [id, rule] of Object.entries(operations)) {
    const entry = byId.get(id);

    if (!entry) {
      problems.push(`The rules list ${id}, which the API no longer offers`);
      continue;
    }

    if (entry.method !== "get" && !rule.change)
      problems.push(`${entry.method.toUpperCase()} ${id} changes data; give it a change`);

    if (reserved.has(rule.name) || names.has(rule.name))
      problems.push(`${id} becomes method ${rule.name}, which is taken`);
    names.add(rule.name);
  }

  if (problems.length) throw new Error(problems.join("\n"));

  const runtime: Record<string, OpenapiOperation> = {};
  let usesBinary = false;

  const generated = Object.entries(operations).map(([id, rule]) => {
    const found = byId.get(id);

    if (!found) throw new Error(`The rules list ${id}, which the API no longer offers`);
    const { path, item, method, entry } = found;
    const change = rule.change ? changes.parse(rule.change) : null;

    // Header parameters, such as Graph's ConsistencyLevel, are not offered.
    // An operation's parameter replaces the path's parameter of the same name and place.
    const declared = new Map(
      [...(item.parameters ?? []), ...(entry.parameters ?? [])].map((value) => {
        const resolved = resolve(value, "parameters", parameter);

        return [`${resolved.in}:${resolved.name}`, resolved] as const;
      }),
    );

    const parameters = [...declared.values()].filter(
      (value) => (value.in === "path" || value.in === "query") && !value.deprecated,
    );

    const body = entry.requestBody
      ? resolve(entry.requestBody, "requestBodies", requestBody)
      : null;

    const jsonBody = body?.content?.["application/json"]?.schema;
    const bodyKind = !body ? null : jsonBody ? "json" : "text";

    const success = Object.entries(entry.responses ?? {})
      .flatMap(([code, value]) =>
        code.startsWith("2") ? [resolve(value, "responses", response)] : [],
      )
      .find((value) => value.content);

    const jsonResponse = success?.content?.["application/json"]?.schema;
    const responseKind = !success ? null : jsonResponse ? "json" : "binary";

    // Pages are read again with GET; Graph also marks some actions pageable.
    const pageable = method === "get" && entry["x-ms-pageable"] !== undefined;

    runtime[rule.name] = {
      httpMethod: method.toUpperCase(),
      path,
      pathParameters: Object.fromEntries(
        parameters.flatMap((value) =>
          value.in === "path" ? [[value.name, inputName(value.name)]] : [],
        ),
      ),
      // Form style, the default for queries, repeats lists unless `explode` is false.
      queryParameters: Object.fromEntries(
        parameters.flatMap((value) =>
          value.in === "query" ? [queryParameter(value.name, value.explode ?? true)] : [],
        ),
      ),
      body: bodyKind,
      bodyRequired: body?.required === true,
      response: responseKind,
      pageable,
      change,
    };

    const fields = parameters.map((value) => {
      const declaredType = value.schema ?? { type: "string" };

      // A path needs a value: path parameters are never null.
      const type = typeOf(
        value.in === "path" ? { ...declaredType, nullable: false } : declaredType,
        "    ",
      );

      return `${comment(single(value.description), "    ")}    ${propertyName(inputName(value.name))}${value.in === "path" || value.required ? "" : "?"}: ${type};`;
    });

    if (bodyKind)
      fields.push(
        `${comment(single(body?.description) || "The request body.", "    ")}    body${body?.required ? "" : "?"}: ${jsonBody ? typeOf(jsonBody, "    ") : "string"};`,
      );

    if (bodyKind === "text")
      fields.push(
        `    /** The body's media type, \`application/octet-stream\` unless given. */\n    contentType?: string;`,
      );

    if (pageable)
      fields.push(
        `    /**\n     * The \`@odata.nextLink\` of an earlier answer, or its \`@odata.deltaLink\`. The\n     * method then reads that address and ignores the other arguments.\n     */\n    nextLink?: string;`,
      );

    const result = !responseKind
      ? "null"
      : jsonResponse
        ? typeOf(jsonResponse, "  ")
        : "BinaryContent";

    if (responseKind === "binary") usesBinary = true;

    const required =
      parameters.some((value) => value.in === "path" || value.required) || body?.required === true;

    const input = fields.length ? `{\n${fields.join("\n")}\n  }` : "Record<string, never>";

    const approval =
      change === null
        ? ""
        : change === "create"
          ? "Asks the user first when their approval level is `all_changes`."
          : "Asks the user first unless their approval level is `none`.";

    const description = comment(
      [entry.summary, entry.description !== entry.summary ? entry.description : "", approval]
        .filter(Boolean)
        .join("\n\n"),
      "  ",
    );

    return `${description}  async ${rule.name}(input: ${input}${required ? "" : " = {}"}): Promise<${service.result}<${result}>> {\n    return run(this.env, this.ctx.props, ${JSON.stringify(rule.name)}, input);\n  }\n`;
  });

  // Types the offered methods reach, in name order.
  const models: string[] = [];

  while (pending.length) {
    const key = pending.shift();

    if (key === undefined) break;
    const value = schemas[key];

    if (!value) continue;
    const body = typeOf(value, "");
    models.push(
      `${comment(describe(value) || value.title)}export type ${typeNames.get(key)} = ${body};\n`,
    );
  }

  models.sort((left, right) =>
    (/export type (\w+)/.exec(left)?.[1] ?? "").localeCompare(
      /export type (\w+)/.exec(right)?.[1] ?? "",
      "en",
    ),
  );

  checkTypeNames(
    [...referenced].map((key) => typeNames.get(key) ?? key),
    service,
  );

  const typeText = models.join("\n");
  const used = (name: string) => new RegExp(`\\b${name}\\b`).test(typeText + generated.join(""));
  const base = api.servers[0]?.url.replace(/\/?$/, "/") ?? "";

  return {
    files: {
      "src/api.ts": `${header}import { WorkerEntrypoint } from "cloudflare:workers";
import type { Environment as TemplateEnvironment } from "./context.ts";
${usesBinary ? 'import type { BinaryContent } from "./rest.ts";\n' : ""}import type { ${service.result} } from "./results.ts";
import { type ${service.properties}, run } from "./run.ts";
${["JsonObject", "JsonValue"].some(used) ? `import type { ${["JsonObject", "JsonValue"].filter(used).join(", ")} } from "./selection.ts";\n` : ""}
${typeText}
/**
 * The operations of the ${service.name} API this template offers, as methods.
 * Methods that change data may ask the user first.
 */
export class ${service.className} extends WorkerEntrypoint<TemplateEnvironment, ${service.properties}> {
${generated.join("\n")}}
`,
      "src/schema.ts": `${header}
/** How the runtime calls a method: its HTTP request and the change it makes. */
export type Operation = {
  httpMethod: string;
  path: string;
  /** Input names of path parameters, by the name the path uses. */
  pathParameters: Record<string, string>;
  /** Query parameters by input name: the API's name, and whether a list repeats it. */
  queryParameters: Record<string, [string, boolean]>;
  body: "json" | "text" | null;
  bodyRequired: boolean;
  response: "json" | "binary" | null;
  pageable: boolean;
  change: "create" | "update" | "delete" | "send" | null;
};

/** The API's address, which each method's path extends. */
export const base = ${JSON.stringify(base)};

export const operations = ${JSON.stringify(runtime)} satisfies Record<string, Operation>;
`,
    },
    summary: `${generated.length} methods of ${all.length} operations, ${referenced.size} types`,
  };
};
