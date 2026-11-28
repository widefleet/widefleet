// Generates a template's typed API from an OpenAPI 3 description, or a Swagger
// 2.0 one: one method per offered operation, with typed inputs and results.
// Large APIs, such as Microsoft Graph, describe far more than one template
// offers, so the template's rules list the operations it offers by operation
// ID, each with its method name and, for operations that are not GET, the
// change it makes. Operations without an ID are listed by method and path.
// Rules can add operations the API serves but its description leaves out.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { checkTypeNames, comment, identifier, propertyName } from "./emit.ts";
import { reservedMethod } from "./reserved.ts";
import { csdlDescription, isCsdl } from "./csdl.ts";
import { isOpenapi31, upgradeOpenapi31 } from "./openapi31.ts";
import {
  type Change,
  type GeneratedFiles,
  json,
  type Json,
  jsonEntries,
  jsonObject,
} from "./rules.ts";
import { isSwagger, upgradeSwagger } from "./swagger.ts";

/** Header inputs of an operation, by input name: the header's name and what it carries. */
type HeaderRules = Readonly<Record<string, { name: string; description: string }>>;

/** How an OpenAPI template offers operations. */
export interface OpenapiRules {
  /**
   * Offered operations by operation ID, such as `drives.items.ListChildren`, or
   * by method and path where the description gives no ID, such as
   * `GET /activity-service/activity/{activityId}`, with the method name and,
   * for every operation that is not a GET, its change, or `read` when it only
   * reads. `description` replaces the API's own text where it describes another
   * operation, as Microsoft Graph's does for some. `body` and `result` name the
   * schemas a body or result can be where the description only names their
   * common base, such as Graph's attachment types. `headers` are
   * inputs the method sends as headers the description does not declare, such
   * as Graph's `workbook-session-id`. Where the description leaves out or
   * misdescribes inputs, `parameters` adds OpenAPI parameters or replaces those
   * of the same name and place, and `fields` replaces, adds or, with null,
   * removes the fields of a form body. `form` replaces a form body's whole
   * schema, such as with variants that each require their own fields, and
   * `requiredBody` requires a body the description leaves optional.
   * `encodedPathParameters` names path parameters whose values the API hands
   * out already URL-encoded, such as Notion's property IDs, which are sent as
   * they are.
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
      parameters?: readonly Json[] | undefined;
      fields?: Readonly<Record<string, Json>> | undefined;
      form?: Json | undefined;
      requiredBody?: boolean | undefined;
      encodedPathParameters?: readonly string[] | undefined;
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

type OperationRule = OpenapiRules["operations"][string];

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

// How a form field is encoded, such as a list joined with commas.
const encoding = z.looseObject({ style: z.string().optional(), explode: z.boolean().optional() });

const content = z.record(
  z.string(),
  z.looseObject({
    schema: schema.optional(),
    encoding: z.record(z.string(), encoding).optional(),
  }),
);

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
  // A server variable, such as the host of a customer's environment, is an
  // input of every method.
  servers: z
    .array(
      z.object({
        url: z.string(),
        // Variables become inputs, so their names are identifiers.
        variables: z
          .record(
            z.string().regex(/^[A-Za-z_]\w*$/, "Server variable names are identifiers"),
            z.object({ default: z.string(), description: z.string().optional() }),
          )
          .optional(),
      }),
    )
    .min(1),
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
  /** Path parameters a call may leave out, by the name the path uses, such as an OData function's optional parameter. */
  optionalPathParameters?: string[];
  /** Path parameters sent as given, by the name the path uses: values the API hands out URL-encoded. */
  encodedPathParameters?: string[];
  /** Query inputs that are maps, each of whose fields is sent as its own parameter. */
  explodedParameters?: string[];
  /**
   * Query parameters by input name: the API's name, the separator that joins a
   * list into one value, or null to repeat the parameter, and whether it is required.
   */
  queryParameters: Record<string, [string, string | null, boolean]>;
  /** Header names by input name. */
  headerParameters: Record<string, string>;
  /** Headers every request sends with their one allowed value, such as an API version. */
  fixedHeaders?: Record<string, string>;
  body: "json" | "form" | "multipart" | "text" | "file" | null;
  /** Form fields whose lists are joined into one value, with the separator; others repeat. */
  formLists?: Record<string, string>;
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

// A query parameter in the exploded form style whose value is a map of values,
// each sent as its own parameter.
const explodedMap = (
  value: { style?: string | undefined; explode?: boolean | undefined },
  target: Schema | undefined,
) =>
  (value.style ?? "form") === "form" &&
  value.explode !== false &&
  target?.type === "object" &&
  !target.properties &&
  z
    .object({ type: z.enum(["string", "number", "integer", "boolean"]) })
    .safeParse(target.additionalProperties).success;

const queryParameter = (
  name: string,
  separator: string | null,
  required: boolean,
): [string, [string, string | null, boolean]] => [aliasInput(name), [name, separator, required]];

// An OData parameter alias, such as `@Target`, carries a function's list,
// object or row as JSON; its input drops the `@`.
const isAlias = (name: string) => name.startsWith("@");

const aliasInput = (name: string) => (isAlias(name) ? name.slice(1) : name);

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

// OpenAPI 3 has no tab-separated style; the Swagger 2.0 upgrade writes `tsv` lists as this one.
const separators = {
  form: ",",
  spaceDelimited: " ",
  pipeDelimited: "|",
  tabDelimited: "\t",
} as const;

const listStyle = z.enum(["form", "spaceDelimited", "pipeDelimited", "tabDelimited"]);

// The separator that joins a list into one value, or null to repeat it. Form
// style repeats unless `explode` is false; the delimited styles join unless it is true.
const separator = (
  where: string,
  value: { style?: string | undefined; explode?: boolean | undefined },
) => {
  const style = value.style ?? "form";

  if (value.explode ?? style === "form") return null;
  const known = listStyle.safeParse(style);

  if (!known.success) throw new Error(`${where} has the unsupported style ${style}`);

  return separators[known.data];
};

const single = (text: string | undefined) => text?.replace(/\s*\n\s*/g, " ") ?? "";

// Keywords that constrain a value; a schema without them only annotates it.
const constraining = [
  "$ref",
  "type",
  "enum",
  "properties",
  "additionalProperties",
  "items",
  "allOf",
  "anyOf",
  "oneOf",
] as const;

const annotationOnly = (value: Schema) => constraining.every((key) => value[key] === undefined);

/** A description's JSON or YAML text, parsed. */
export const parseDescription = (
  source: string,
  url?: string,
  variables: Readonly<Record<string, string>> = {},
) => {
  const text = source.trimStart();

  // OData's service root is the address of its `$metadata` without that segment.
  if (isCsdl(text)) {
    if (!url) throw new Error("A CSDL description needs the address of its $metadata");

    return csdlDescription(text, url.replace(/\/\$metadata$/, ""), variables);
  }

  return json.parse(
    text.startsWith("{") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: -1 }),
  );
};

// JSON as text with object keys in order, so equal values compare equal
// whatever order a part lists their keys in. Lists keep their order.
const canonical = (value: Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = jsonEntries(value);

  if (!entries) return JSON.stringify(value);

  return `{${entries
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
};

/**
 * One description from the parts a provider publishes it in, such as one page
 * per operation, each a complete document with the components its operations
 * use. The parts must agree on every operation and component they share and on
 * the rest of the document, such as its servers.
 */
export const mergeDescriptions = (parts: readonly Json[]): Json => {
  const paths: Record<string, Record<string, Json>> = {};
  const components: Record<string, Record<string, Json>> = {};
  // The rest of the first part, which every other part must repeat.
  let shared: { text: string; fields: Record<string, Json> } | undefined;

  // Entries by name, which every part that names one must describe alike.
  const add = (target: Record<string, Json>, entries: Json, where: (key: string) => string) => {
    for (const [key, value] of Object.entries(jsonObject.parse(entries))) {
      const existing = target[key];

      if (existing !== undefined && canonical(existing) !== canonical(value))
        throw new Error(`The description's parts describe ${where(key)} differently`);
      target[key] = value;
    }
  };

  for (const part of parts) {
    const {
      paths: partPaths = {},
      components: partComponents = {},
      ...rest
    } = jsonObject.parse(part);

    const text = canonical(rest);

    if (shared !== undefined && text !== shared.text)
      throw new Error("The description's parts differ outside their paths and components");
    shared ??= { text, fields: rest };

    for (const [path, item] of Object.entries(jsonObject.parse(partPaths)))
      add((paths[path] ??= {}), item, (key) => `${key} ${path}`);

    for (const [section, entries] of Object.entries(jsonObject.parse(partComponents)))
      add((components[section] ??= {}), entries, (name) => `${section}.${name}`);
  }

  return { ...shared?.fields, paths, components };
};

// Form bodies by their media type; other bodies that are not JSON are sent as text.
const formBodies = {
  "application/x-www-form-urlencoded": "form",
  "multipart/form-data": "multipart",
} as const;

// A form body's schema with the rules' fields: replaced, added or, when null, removed.
const formSchema = (id: string, value: Schema | undefined, fields: OperationRule["fields"]) => {
  if (!fields) return value;

  if (!value?.properties)
    throw new Error(`${id}'s fields rule needs a form body that lists its fields`);
  const properties = { ...value.properties };

  for (const [name, field] of Object.entries(fields))
    if (field === null) delete properties[name];
    else properties[name] = schema.parse(field);

  return {
    ...value,
    properties,
    required: (value.required ?? []).filter((name) => Object.hasOwn(properties, name)),
  };
};

export const generateOpenapi = (
  description: Json,
  { operations: described, navigation = {}, bindings = {}, undescribed = {} }: OpenapiRules,
  service: OpenapiService,
  header: string,
): GeneratedFiles => {
  const api = document.parse(
    isSwagger(description)
      ? upgradeSwagger(description)
      : isOpenapi31(description)
        ? upgradeOpenapi31(description)
        : description,
  );

  const server = api.servers[0];
  const serverVariables = Object.entries(server?.variables ?? {});

  // The address must be a URL whatever the variables hold.
  z.url().parse(
    serverVariables.reduce(
      (url, [name, variable]) => url.replaceAll(`{${name}}`, variable.default),
      server?.url ?? "",
    ),
  );

  const serverFields = serverVariables.map(
    ([name, variable]) =>
      `${comment(variable.description, "    ")}    ${propertyName(name)}: string;`,
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
  // Whether binary strings are being typed as files a multipart body uploads.
  let uploads = false;
  let usesUpload = false;
  // The schemas a multipart body's type writes out, which a schema may not repeat.
  const inlined: string[] = [];

  // A form schema's fields, through a reference and in each of its variants,
  // which may each name a field differently.
  const fieldsOf = (value: Schema | undefined): [string, Schema][] =>
    value?.$ref
      ? fieldsOf(schemas[value.$ref.replace("#/components/schemas/", "")])
      : [
          ...[...(value?.oneOf ?? []), ...(value?.anyOf ?? [])].flatMap(fieldsOf),
          ...Object.entries(value?.properties ?? {}),
        ];

  // Whether a field holds objects, or lists of them, through references.
  const holdsObjects = (value: Schema, seen: Set<string>): boolean => {
    if (value.$ref) {
      const key = value.$ref.replace("#/components/schemas/", "");
      const target = schemas[key];

      if (seen.has(key) || !target) return false;
      seen.add(key);

      return holdsObjects(target, seen);
    }

    return (
      value.type === "object" ||
      value.properties !== undefined ||
      (value.items !== undefined && holdsObjects(value.items, seen)) ||
      [...(value.allOf ?? []), ...(value.anyOf ?? []), ...(value.oneOf ?? [])].some((part) =>
        holdsObjects(part, seen),
      )
    );
  };

  // Whether a schema holds binary strings, which a multipart body uploads as files.
  const carriesFiles = (value: Schema, seen: Set<string>): boolean => {
    if (value.$ref) {
      const key = value.$ref.replace("#/components/schemas/", "");
      const target = schemas[key];

      if (seen.has(key) || !target) return false;
      seen.add(key);

      return carriesFiles(target, seen);
    }

    return (
      (value.type === "string" && value.format === "binary") ||
      [
        ...Object.values(value.properties ?? {}),
        ...(value.items ? [value.items] : []),
        ...(value.allOf ?? []),
        ...(value.anyOf ?? []),
        ...(value.oneOf ?? []),
        ...(value.additionalProperties === undefined ||
        value.additionalProperties === true ||
        value.additionalProperties === false
          ? []
          : [value.additionalProperties]),
      ].some((part) => carriesFiles(part, seen))
    );
  };

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

    // A multipart body writes out the schemas that carry files, so their binary
    // fields become uploads; the named types keep strings for answers.
    if (value.$ref && uploads && carriesFiles(value, new Set())) {
      const key = value.$ref.replace("#/components/schemas/", "");
      const target = schemas[key];

      if (!target || inlined.includes(key))
        throw new Error(`The multipart schema ${key} carries files and contains itself`);
      inlined.push(key);
      const written = typeOf(target, indent);
      inlined.pop();

      return `${wrap(written)}${nullable}`;
    }

    if (value.$ref) return `${typeName(value.$ref)}${nullable}`;

    if (value.allOf) {
      // A part that only annotates, such as with an example, adds no type.
      const parts = value.allOf
        .filter((part) => !annotationOnly(part))
        .map((part) => wrap(typeOf(part, indent)));

      const own = value.properties ? [objectType(value, indent)] : [];

      // Parts that all annotate leave the schema's own type.
      if (!parts.length && !own.length) {
        const { allOf: _, ...outer } = value;

        return typeOf(outer, indent);
      }

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

      // `string` itself, or a named type of any string, such as Notion's IDs.
      const anyString = (type: string) => {
        const named = schemas[takenTypes.get(type) ?? ""];

        return (
          type === "string" ||
          (named?.type === "string" && !named.enum && !named.nullable && named.format !== "binary")
        );
      };

      const widest = [...types].find(anyString);

      const covered = [...types].map((type) =>
        widest !== undefined && type !== widest && !anyString(type) ? stringValues(type) : null,
      );

      const union = [...types].filter((type, index) => type !== "null" && !covered[index]);

      const nullable =
        types.has("null") || value.nullable === true || covered.some((entry) => entry?.nullable);

      return [...union, ...(nullable ? ["null"] : [])].join(" | ");
    }

    // An enum that lists null already allows it.
    if (value.enum)
      return `${value.enum.map(literal).join(" | ")}${value.enum.includes(null) ? "" : nullable}`;

    switch (value.type) {
      case "integer":
      case "number":
        return `number${nullable}`;
      case "boolean":
        return `boolean${nullable}`;
      case "string":
        if (uploads && value.format === "binary") {
          usesUpload = true;

          return `UploadContent${nullable}`;
        }

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

      return entry
        ? [
            {
              path,
              item,
              method,
              entry,
              id: entry.operationId ?? `${method.toUpperCase()} ${path}`,
            },
          ]
        : [];
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
    // The rules' parameters come last, so they replace the description's.
    const declared = new Map(
      [
        ...(item.parameters ?? []),
        ...(entry.parameters ?? []),
        ...(rule.parameters ?? []).map((value) => parameter.parse(value)),
      ].map((value) => {
        const resolved = resolve(value, "parameters", parameter);

        return [`${resolved.in}:${resolved.name}`, resolved] as const;
      }),
    );

    const parameters = [...declared.values()].filter(
      (value) => (value.in === "path" || value.in === "query") && !value.deprecated,
    );

    // A header the description requires with one allowed value, such as
    // Notion's API version, is not an input: every request sends that value,
    // the one the generated types describe.
    const fixedHeaders = Object.fromEntries(
      [...declared.values()].flatMap((value) => {
        const target = value.schema?.$ref
          ? schemas[value.schema.$ref.replace("#/components/schemas/", "")]
          : value.schema;

        const [only, ...others] = target?.enum ?? [];
        const fixed = z.string().safeParse(only);

        return value.in === "header" &&
          value.required === true &&
          !value.deprecated &&
          fixed.success &&
          others.length === 0
          ? [[value.name, fixed.data]]
          : [];
      }),
    );

    // Every place in the path needs a path parameter to fill it.
    for (const [, name] of path.matchAll(/\{([^}]+)\}/g))
      if (!parameters.some((value) => value.in === "path" && value.name === name))
        throw new Error(`${id}'s path ${path} has {${name}}, which no path parameter fills`);

    const body = entry.requestBody
      ? resolve(entry.requestBody, "requestBodies", requestBody)
      : null;

    // JSON is chosen by its media type; a JSON entry without a schema takes any JSON.
    // Forms send their fields, and multipart forms also files.
    const jsonBody = body?.content?.["application/json"];

    // Only the body that is sent counts: JSON before forms, then a form that
    // carries files, which only multipart can send, then the first form.
    // Checks of the form's fields and encoding apply to that body alone.
    const forms = jsonBody
      ? []
      : Object.entries(formBodies).flatMap(([type, kind]) => {
          const entry = body?.content?.[type];

          return entry ? [{ kind, entry }] : [];
        });

    // The rules' form or fields may carry files the description's forms leave out.
    const ruleFiles = [
      ...(rule.form === undefined ? [] : [rule.form]),
      ...Object.values(rule.fields ?? {}).filter((field) => field !== null),
    ].some((value) => carriesFiles(schema.parse(value), new Set()));

    const sentForm =
      forms.find(
        ({ kind, entry }) =>
          kind === "multipart" &&
          (ruleFiles || (entry.schema !== undefined && carriesFiles(entry.schema, new Set()))),
      ) ?? forms[0];

    if (rule.fields && !sentForm)
      throw new Error(`${id}'s fields rule needs a form body that lists its fields`);

    if (rule.form && !sentForm) throw new Error(`${id}'s form rule needs a form body`);

    if (rule.fields && rule.form)
      throw new Error(`${id} gives both fields and a form; describe the fields in the form`);

    const form = sentForm && {
      ...sentForm,
      schema:
        rule.form === undefined
          ? formSchema(id, sentForm.entry.schema, rule.fields)
          : schema.parse(rule.form),
    };

    // Multipart forms send objects as JSON parts; plain forms have no encoding for them.
    if (form?.kind === "form")
      for (const [name, field] of fieldsOf(form.schema))
        if (holdsObjects(field, new Set()))
          throw new Error(`${id}'s form field ${name} is an object, which a form cannot send`);

    // Form fields whose lists the encoding joins into one value.
    const formLists = Object.fromEntries(
      Object.entries(form?.entry.encoding ?? {}).flatMap(([name, value]) => {
        const joined = separator(`${id}'s form field ${name}`, value);

        return joined === null ? [] : [[name, joined]];
      }),
    );

    // Content that is bytes, such as a file, is uploaded as a file; other
    // content as text.
    const content = body?.content ? Object.entries(body.content)[0] : undefined;

    const file =
      !jsonBody &&
      !form &&
      content !== undefined &&
      !content[0].startsWith("text/") &&
      content[1].schema?.type === "string" &&
      content[1].schema.format === "binary";

    const bodyKind = !body ? null : jsonBody ? "json" : form ? form.kind : file ? "file" : "text";

    // The rules may require a body the description leaves optional, but not add one.
    if (rule.requiredBody && !body) throw new Error(`${id}'s requiredBody rule needs a body`);

    const bodyRequired = body?.required === true || rule.requiredBody === true;

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

    const call: OpenapiOperation = {
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
            ? [
                queryParameter(
                  value.name,
                  isAlias(value.name)
                    ? null
                    : separator(`${id}'s query parameter ${value.name}`, value),
                  value.required === true,
                ),
              ]
            : [],
        ),
      ),
      headerParameters: Object.fromEntries(headers.map(([input, { name }]) => [input, name])),
      body: bodyKind,
      bodyRequired,
      response: responseKind,
      pageable,
      change,
    };

    if (Object.keys(formLists).length) call.formLists = formLists;

    if (Object.keys(fixedHeaders).length) call.fixedHeaders = fixedHeaders;

    for (const name of rule.encodedPathParameters ?? [])
      if (!parameters.some((value) => value.in === "path" && value.name === name))
        throw new Error(`${id} has no path parameter ${name} to send encoded`);

    if (rule.encodedPathParameters?.length)
      call.encodedPathParameters = [...rule.encodedPathParameters];

    const optionalPath = parameters.flatMap((value) =>
      value.in === "path" && value.required === false ? [value.name] : [],
    );

    if (optionalPath.length) call.optionalPathParameters = optionalPath;

    const explodedInputs = parameters.flatMap((value) =>
      value.in === "query" &&
      explodedMap(
        value,
        value.schema?.$ref
          ? schemas[value.schema.$ref.replace("#/components/schemas/", "")]
          : value.schema,
      )
        ? [aliasInput(value.name)]
        : [],
    );

    if (explodedInputs.length) call.explodedParameters = explodedInputs;
    runtime[rule.name] = call;

    const inputOf = (value: z.infer<typeof parameter>) =>
      value.in === "path" ? inputName(value.name) : aliasInput(value.name);

    const inputs = [
      ...parameters.map(inputOf),
      ...headers.map(([input]) => input),
      ...(bodyKind ? ["body"] : []),
      ...(bodyKind === "text" ? ["contentType"] : []),
      ...(pageable ? ["nextLink"] : []),
      ...serverVariables.map(([name]) => name),
    ];

    const repeated = inputs.find((name, index) => inputs.indexOf(name) !== index);

    if (repeated) throw new Error(`${id} has two inputs named ${repeated}`);

    const fields = parameters.map((value) => {
      const declaredType = value.schema ?? { type: "string" };

      // A path parameter the path has no place for would never be sent.
      if (value.in === "path" && !path.includes(`{${value.name}}`))
        throw new Error(`${id}'s path parameter ${value.name} has no place in its path ${path}`);

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

      // Queries carry values and lists of them, and in the exploded form style
      // a map of values, each sent as its own parameter; the runtime sends no
      // other objects.
      const exploded = explodedMap(value, target);

      if (
        value.in === "query" &&
        !isAlias(value.name) &&
        !exploded &&
        (target?.type === "object" || target?.properties)
      )
        throw new Error(
          `${id} has the object query parameter ${value.name}, which is not supported`,
        );

      // A path needs a value: path parameters are never null. 64-bit IDs may
      // exceed what a JSON number holds exactly, so they may also be strings.
      const type = `${typeOf(
        value.in === "path" ? { ...declaredType, nullable: false } : declaredType,
        "    ",
      )}${target?.type === "integer" && target.format === "int64" ? " | string" : ""}`;

      return `${comment(single(value.description), "    ")}    ${propertyName(inputOf(value))}${(value.in === "path" && value.required !== false) || value.required ? "" : "?"}: ${type};`;
    });

    // Header inputs, such as a session, apply to every page.
    const headerFields = headers.map(
      ([input, { description }]) =>
        `${comment(description, "    ")}    ${propertyName(input)}?: string;`,
    );

    fields.push(...headerFields, ...serverFields);

    // A form's fields are typed by its schema; a multipart form's binary fields are files.
    const bodyType = () => {
      if (rule.body) return schemaUnion(rule.body);

      if (jsonBody) return jsonBody.schema ? typeOf(jsonBody.schema, "    ") : "JsonValue";

      if (bodyKind === "file") {
        usesUpload = true;

        return "UploadContent";
      }

      if (!form) return "string";
      uploads = form.kind === "multipart";
      const type = form.schema ? typeOf(form.schema, "    ") : "JsonObject";
      uploads = false;

      return type;
    };

    if (bodyKind)
      fields.push(
        `${comment(single(rule.form === undefined ? body?.description : form?.schema?.description) || "The request body.", "    ")}    body${bodyRequired ? "" : "?"}: ${bodyType()};`,
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
      parameters.some(
        (value) => (value.in === "path" && value.required !== false) || value.required,
      ) ||
      bodyRequired ||
      serverVariables.length > 0;

    const firstPage = fields.length ? `{\n${fields.join("\n")}\n  }` : "Record<string, never>";

    // A later page needs only its address and the headers of the first.
    const input = pageable
      ? `${firstPage} | {\n    /**\n     * The \`@odata.nextLink\` of an earlier answer, or its \`@odata.deltaLink\`.\n     */\n    nextLink: string;\n${[...headerFields, ...serverFields].map((field) => `${field}\n`).join("")}  }`
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
${usesBinary || usesUpload ? `import type { ${[...(usesBinary ? ["BinaryContent"] : []), ...(usesUpload ? ["UploadContent"] : [])].join(", ")} } from "./content.ts";\n` : ""}import type { ${service.result} } from "./results.ts";
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
  /** Path parameters a call may leave out, by the name the path uses, such as an OData function's optional parameter. */
  optionalPathParameters?: string[];
  /** Path parameters sent as given, by the name the path uses: values the API hands out URL-encoded. */
  encodedPathParameters?: string[];
  /** Query inputs that are maps, each of whose fields is sent as its own parameter. */
  explodedParameters?: string[];
  /**
   * Query parameters by input name: the API's name, the separator that joins a
   * list into one value, or null to repeat the parameter, and whether it is required.
   */
  queryParameters: Record<string, [string, string | null, boolean]>;
  /** Header names by input name. */
  headerParameters: Record<string, string>;
  /** Headers every request sends with their one allowed value, such as an API version. */
  fixedHeaders?: Record<string, string>;
  body: "json" | "form" | "multipart" | "text" | "file" | null;
  /** Form fields whose lists are joined into one value, with the separator; others repeat. */
  formLists?: Record<string, string>;
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
