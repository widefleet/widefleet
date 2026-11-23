// Generates a template's typed API from an OpenAPI 3 description: one method
// per offered operation, with typed inputs and results. Large APIs, such as
// Microsoft Graph, describe far more than one template offers, so the
// template's rules list the operations it offers by operation ID, each with
// its method name and, for operations that are not GET, the change it makes.
// Rules can add operations the API serves but its description leaves out.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { checkTypeNames, comment, identifier, propertyName } from "./emit.ts";
import { reservedMethod } from "./reserved.ts";
import type { Change, GeneratedFiles } from "./rules.ts";

/** Header inputs of an operation, by input name: the header's name and what it carries. */
type HeaderRules = Readonly<Record<string, { name: string; description: string }>>;

/** How an OpenAPI template offers operations. */
export interface OpenapiRules {
  /**
   * Offered operations by operation ID, such as `drives.items.ListChildren`, with
   * the method name and, for every operation that is not a GET, its change, or
   * `read` when it only reads. `description` replaces the API's own text where it
   * describes another operation, as Microsoft Graph's does for some. `body` and
   * `result` name the schemas a body or result can be where the description only
   * names their common base, such as Graph's attachment types. `headers` are
   * inputs the method sends as headers the description does not declare, such
   * as Graph's `workbook-session-id`.
   */
  operations: Record<
    string,
    {
      name: string;
      change?: Change | "read" | undefined;
      description?: string | undefined;
      body?: readonly string[] | undefined;
      result?: readonly string[] | undefined;
      headers?: HeaderRules | undefined;
    }
  >;
  /**
   * Operations the API serves but its description leaves out, by method name:
   * the HTTP method sent to the path of a described operation, with the change
   * it makes, its description and the schemas of its JSON body and result.
   * Graph updates a worksheet range with a PATCH to the address its `range`
   * function reads. Without `result`, the operation answers nothing.
   */
  undescribed?:
    | Readonly<
        Record<
          string,
          {
            operation: string;
            method: "post" | "put" | "patch" | "delete";
            change: Change;
            description: string;
            body: readonly string[];
            result?: readonly string[] | undefined;
            headers?: HeaderRules | undefined;
          }
        >
      >
    | undefined;
  /**
   * Navigation properties the types keep, by schema and property, with the
   * schemas their values can be. Graph accepts some of them inline, such as a
   * message's attachments when sending it.
   */
  navigation?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> | undefined;
  /**
   * Navigation properties a body can bind to existing entities, by schema: the
   * type gains `<property>@odata.bind` for the entity's address, or a list of
   * addresses for a collection. Graph adds a chat's members by binding `user`.
   */
  bindings?: Readonly<Record<string, readonly string[]>> | undefined;
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
  /**
   * Query parameters by input name: the API's name, the separator that joins a
   * list into one value, or null to repeat the parameter, and whether it is required.
   */
  queryParameters: Record<string, [string, string | null, boolean]>;
  /** Header names by input name. */
  headerParameters: Record<string, string>;
  body: "json" | "text" | null;
  bodyRequired: boolean;
  response: "json" | "binary" | null;
  /** Whether the method continues at an earlier result's `@odata.nextLink`. */
  pageable: boolean;
  change: Change | null;
};

const changes = z.enum(["create", "update", "delete", "send"]);

// A path parameter's name as an input field: `drive-id` is `driveId`. Query
// parameters keep the API's names, quoted where they are not identifiers.
const inputName = (name: string) =>
  /^[A-Za-z_$][\w$]*$/.test(name)
    ? name
    : name.replace(/[^\w$]+(\w)?/g, (_, next?: string) => next?.toUpperCase() ?? "");

const queryParameter = (
  name: string,
  separator: string | null,
  required: boolean,
): [string, [string, string | null, boolean]] => [name, [name, separator, required]];

// The characters of a type, and whether each lies outside nested types and quoted values.
const characters = (type: string) => {
  const result: { character: string; outside: boolean }[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (const character of type) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if ("{([<".includes(character)) depth++;
    else if ("})]>".includes(character)) depth--;

    result.push({ character, outside: !quoted && depth === 0 && character !== '"' });
  }

  return result;
};

const separators = { form: ",", spaceDelimited: " ", pipeDelimited: "|" } as const;

const listStyle = z.enum(["form", "spaceDelimited", "pipeDelimited"]);

// The separator that joins a query list into one value, or null to repeat it.
const separator = (id: string, value: z.infer<typeof parameter>) => {
  if (value.explode ?? true) return null;
  const style = listStyle.safeParse(value.style ?? "form");

  if (!style.success)
    throw new Error(
      `${id}'s query parameter ${value.name} has the unsupported style ${value.style}`,
    );

  return separators[style.data];
};

const single = (text: string | undefined) => text?.replace(/\s*\n\s*/g, " ") ?? "";

export const generateOpenapi = (
  source: string,
  { operations: described, navigation = {}, bindings = {}, undescribed = {} }: OpenapiRules,
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

    typeNames.set(key, name);
  }

  // The schemas the offered methods reach, by type name. Only these must have
  // distinct names, so unrelated parts of a large API cannot block generation.
  const takenTypes = new Map<string, string>();
  const referenced = new Set<string>();
  const pending: string[] = [];

  // The schema whose type is being written, which navigation rules name.
  let owner: string | undefined;

  const typeName = (ref: string) => {
    const key = ref.replace("#/components/schemas/", "");
    const name = typeNames.get(key);

    if (!name) throw new Error(`${ref} is not described`);

    if (!referenced.has(key)) {
      const other = takenTypes.get(name);

      if (other) throw new Error(`Schemas ${other} and ${key} both become type ${name}`);
      takenTypes.set(name, key);
      referenced.add(key);
      pending.push(key);
    }

    return name;
  };

  const literal = (value: string | number | boolean | null) => JSON.stringify(value);

  // A union of the named schemas, which rules give for a body or result.
  const schemaUnion = (keys: readonly string[]) =>
    keys.map((key) => typeName(`#/components/schemas/${key}`)).join(" | ");

  // The members of a union, outside nested types and quoted values.
  const members = (type: string) => {
    const parts = [""];

    for (const { character, outside } of characters(type))
      if (outside && character === "|") parts.push("");
      else parts[parts.length - 1] += character;

    return parts.map((part) => part.trim());
  };

  // A string literal, or a schema of string values and maybe null: which values
  // `string` covers, and whether null remains. Other types are null.
  const stringValues = (type: string) => {
    if (/^"(?:[^"\\]|\\.)*"$/.test(type)) return { nullable: false };
    const value = schemas[takenTypes.get(type) ?? ""];

    return value?.type === "string" && value.enum
      ? { nullable: value.nullable === true || value.enum.includes(null) }
      : null;
  };

  // Parentheses for a union or intersection inside another type. Unions inside
  // an object type's fields or quoted values need none.
  const wrap = (type: string) =>
    characters(type).some(
      ({ character, outside }) => outside && (character === "|" || character === "&"),
    )
      ? `(${type})`
      : type;

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
    // A union with `string` needs none of the string values it also lists, but
    // keeps the null a nullable enum allows.
    if (variants) {
      const types = new Set(
        variants.flatMap((member) =>
          member.type === "object" &&
          !member.properties &&
          !member.additionalProperties &&
          !member.$ref &&
          member.nullable
            ? ["null"]
            : members(typeOf(member, indent)),
        ),
      );

      const covered = [...types].map((type) =>
        types.has("string") && type !== "string" ? stringValues(type) : null,
      );

      const union = [...types].filter((type, index) => type !== "null" && !covered[index]);

      const nullable =
        types.has("null") || value.nullable === true || covered.some((entry) => entry?.nullable);

      return [...union, ...(nullable ? ["null"] : [])].join(" | ");
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
    const kept = owner === undefined ? {} : (navigation[owner] ?? {});
    const bound = owner === undefined ? [] : (bindings[owner] ?? []);

    // Navigation fields appear only when a rule keeps them, typed as it says.
    const typed = Object.entries(value.properties ?? {})
      .filter(
        ([name, field]) =>
          !field.deprecated && (!field["x-ms-navigationProperty"] || Object.hasOwn(kept, name)),
      )
      .map(([name, field]) => {
        const values = field["x-ms-navigationProperty"] ? kept[name] : undefined;

        const type = values
          ? field.type === "array"
            ? `(${schemaUnion(values)})[]`
            : schemaUnion(values)
          : typeOf(field, `${indent}  `);

        return { name, field, type };
      });

    // A bound navigation property names its entity by address.
    for (const [name, field] of Object.entries(value.properties ?? {}))
      if (field["x-ms-navigationProperty"] && bound.includes(name))
        typed.push({
          name: `${name}@odata.bind`,
          field: { description: `Binds ${name} to the existing entity at this address.` },
          type: field.type === "array" ? "string[]" : "string",
        });

    const fields = typed.map(
      ({ name, field, type }) =>
        `${comment(describe(field), `${indent}  `)}${indent}  ${propertyName(name)}${required.has(name) ? "" : "?"}: ${type};`,
    );

    // Every named field must also fit the type of the other keys.
    if (value.additionalProperties) {
      const others =
        value.additionalProperties === true
          ? "JsonValue"
          : typeOf(value.additionalProperties, `${indent}  `);

      const named = typed.map(({ type }) => type);

      const keys =
        others === "JsonValue"
          ? others
          : [...new Set([others, ...named].flatMap(members))].join(" | ");

      fields.push(`${indent}  [key: string]: ${keys};`);
    }

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
  const names = new Set<string>();
  const added: OpenapiRules["operations"] = {};

  // Each binding names a navigation property its schema declares.
  for (const [key, names] of Object.entries(bindings)) {
    const value = schemas[key];

    const declared = [value, ...(value?.allOf ?? [])].flatMap((part) =>
      Object.entries(part?.properties ?? {}).flatMap(([name, field]) =>
        field["x-ms-navigationProperty"] ? [name] : [],
      ),
    );

    for (const name of names)
      if (!declared.includes(name))
        problems.push(`The bindings name ${key}.${name}, which is not a navigation property`);
  }

  // An undescribed operation shares the path and path parameters of the
  // operation it names and takes the JSON its rule names.
  for (const [name, rule] of Object.entries(undescribed)) {
    const found = byId.get(rule.operation);
    const id = `${rule.method.toUpperCase()} ${rule.operation}`;

    if (!found) {
      problems.push(`${name} uses the path of ${rule.operation}, which the API no longer offers`);
      continue;
    }

    if (found.item[rule.method] !== undefined)
      problems.push(`The API now describes ${id}; offer its operation instead of ${name}`);

    const json = { content: { "application/json": {} } };

    byId.set(id, {
      ...found,
      method: rule.method,
      id,
      entry: {
        operationId: id,
        parameters: (found.entry.parameters ?? []).filter(
          (value) => resolve(value, "parameters", parameter).in === "path",
        ),
        requestBody: { required: true, ...json },
        responses: rule.result ? { "200": json } : { "204": { description: "No content" } },
      },
    });
    const { change, description, body, result, headers } = rule;

    if (Object.hasOwn(added, id)) problems.push(`${name} repeats the undescribed target ${id}`);
    added[id] = { name, change, description, body, result, headers };
  }

  // Each added method follows the method whose path it shares.
  const operations = Object.fromEntries([
    ...Object.entries(described).flatMap((entry) => [
      entry,
      ...Object.entries(added).filter(([id]) => id.endsWith(` ${entry[0]}`)),
    ]),
    ...Object.entries(added).filter(
      ([id]) => !Object.hasOwn(described, id.slice(id.indexOf(" ") + 1)),
    ),
  ]);

  for (const [id, rule] of Object.entries(operations)) {
    const entry = byId.get(id);

    if (!entry) {
      problems.push(`The rules list ${id}, which the API no longer offers`);
      continue;
    }

    if (entry.method !== "get" && !rule.change)
      problems.push(`${entry.method.toUpperCase()} ${id} changes data; give it a change`);

    if (reservedMethod(rule.name) || names.has(rule.name))
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
    const change = rule.change && rule.change !== "read" ? changes.parse(rule.change) : null;

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

    // JSON is chosen by its media type; a JSON entry without a schema takes any JSON.
    const jsonBody = body?.content?.["application/json"];
    const bodyKind = !body ? null : jsonBody ? "json" : "text";

    // Every success answer counts: JSON, other content, or none, such as a 204.
    const successes = Object.entries(entry.responses ?? {}).flatMap(([code, value]) =>
      code.startsWith("2") ? [resolve(value, "responses", response)] : [],
    );

    const contents = successes.flatMap((value) =>
      value.content && Object.keys(value.content).length ? [value.content] : [],
    );

    const jsonResponses = contents.flatMap((content) => {
      const json = content["application/json"];

      return json ? [json] : [];
    });

    const binary = contents.length > jsonResponses.length;

    if (binary && jsonResponses.length)
      throw new Error(`${id} answers with JSON and with other content, which is not supported`);
    const empty = contents.length < successes.length;
    const responseKind = binary ? "binary" : jsonResponses.length ? "json" : null;

    const headers = Object.entries(rule.headers ?? {});

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
      // Lists repeat the parameter unless `explode` is false; then form style, the
      // default, joins them with commas, and the delimited styles with their delimiter.
      queryParameters: Object.fromEntries(
        parameters.flatMap((value) =>
          value.in === "query"
            ? [queryParameter(value.name, separator(id, value), value.required === true)]
            : [],
        ),
      ),
      headerParameters: Object.fromEntries(headers.map(([input, { name }]) => [input, name])),
      body: bodyKind,
      bodyRequired: body?.required === true,
      response: responseKind,
      pageable,
      change,
    };

    const inputOf = (value: z.infer<typeof parameter>) =>
      value.in === "path" ? inputName(value.name) : value.name;

    const inputs = [
      ...parameters.map(inputOf),
      ...headers.map(([input]) => input),
      ...(bodyKind ? ["body"] : []),
      ...(bodyKind === "text" ? ["contentType"] : []),
      ...(pageable ? ["nextLink"] : []),
    ];

    const repeated = inputs.find((name, index) => inputs.indexOf(name) !== index);

    if (repeated) throw new Error(`${id} has two inputs named ${repeated}`);

    const fields = parameters.map((value) => {
      const declaredType = value.schema ?? { type: "string" };

      const target = value.schema?.$ref
        ? schemas[value.schema.$ref.replace("#/components/schemas/", "")]
        : value.schema;

      // Path values are written as they are, in the default simple style.
      if (value.in === "path" && value.style !== undefined && value.style !== "simple")
        throw new Error(
          `${id}'s path parameter ${value.name} has the unsupported style ${value.style}`,
        );

      // A path holds one value.
      if (
        value.in === "path" &&
        (target?.type === "array" || target?.type === "object" || target?.properties)
      )
        throw new Error(
          `${id} has the path parameter ${value.name} with a list or object, which is not supported`,
        );

      // Queries carry values and lists of them; the runtime sends no objects.
      if (value.in === "query" && (target?.type === "object" || target?.properties))
        throw new Error(
          `${id} has the object query parameter ${value.name}, which is not supported`,
        );

      // A path needs a value: path parameters are never null.
      const type = typeOf(
        value.in === "path" ? { ...declaredType, nullable: false } : declaredType,
        "    ",
      );

      return `${comment(single(value.description), "    ")}    ${propertyName(inputOf(value))}${value.in === "path" || value.required ? "" : "?"}: ${type};`;
    });

    // Header inputs, such as a session, apply to every page.
    const headerFields = headers.map(
      ([input, { description }]) =>
        `${comment(description, "    ")}    ${propertyName(input)}?: string;`,
    );

    fields.push(...headerFields);

    if (bodyKind)
      fields.push(
        `${comment(single(body?.description) || "The request body.", "    ")}    body${body?.required ? "" : "?"}: ${rule.body ? schemaUnion(rule.body) : jsonBody ? (jsonBody.schema ? typeOf(jsonBody.schema, "    ") : "JsonValue") : "string"};`,
      );

    if (bodyKind === "text")
      fields.push(
        `    /** The body's media type, \`application/octet-stream\` unless given. */\n    contentType?: string;`,
      );

    // An empty success answers null; binary content always arrives as BinaryContent.
    // A rule can name the schemas a JSON result can be, where the API names their base.
    const result =
      responseKind === "binary"
        ? "BinaryContent"
        : [
            ...new Set([
              ...(rule.result && jsonResponses.length
                ? [schemaUnion(rule.result)]
                : jsonResponses.map((json) =>
                    json.schema ? typeOf(json.schema, "  ") : "JsonValue",
                  )),
              ...(empty || !responseKind ? ["null"] : []),
            ]),
          ].join(" | ");

    if (responseKind === "binary") usesBinary = true;

    const required =
      parameters.some((value) => value.in === "path" || value.required) || body?.required === true;

    const firstPage = fields.length ? `{\n${fields.join("\n")}\n  }` : "Record<string, never>";

    // A later page needs only its address and the headers of the first.
    const input = pageable
      ? `${firstPage} | {\n    /**\n     * The \`@odata.nextLink\` of an earlier answer, or its \`@odata.deltaLink\`.\n     */\n    nextLink: string;\n${headerFields.map((field) => `${field}\n`).join("")}  }`
      : firstPage;

    const approval =
      change === null
        ? ""
        : change === "create"
          ? "Asks the user first when their approval level is `all_changes`."
          : "Asks the user first unless their approval level is `none`.";

    const description = comment(
      [
        ...(rule.description
          ? [rule.description]
          : [entry.summary, entry.description !== entry.summary ? entry.description : ""]),
        approval,
      ]
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
    owner = key;
    const body = typeOf(value, "");
    owner = undefined;
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
${usesBinary ? 'import type { BinaryContent } from "./content.ts";\n' : ""}import type { ${service.result} } from "./results.ts";
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
  /**
   * Query parameters by input name: the API's name, the separator that joins a
   * list into one value, or null to repeat the parameter, and whether it is required.
   */
  queryParameters: Record<string, [string, string | null, boolean]>;
  /** Header names by input name. */
  headerParameters: Record<string, string>;
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
