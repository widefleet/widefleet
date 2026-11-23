// Generates a template's typed API from a Google API Discovery document: one
// method per API method, with typed inputs and results. Results take a
// selection that Google's `fields` parameter returns. The template's rules
// decide how each method is offered.
import { z } from "zod";
import { checkTypeNames, comment, identifier, propertyName } from "./emit.ts";
import { reservedMethod } from "./reserved.ts";
import type { Change, GeneratedFiles, Hidden } from "./rules.ts";

/** How a Discovery template offers its methods. */
export interface DiscoveryRules {
  /**
   * Methods by Discovery ID, such as `gmail.users.messages.send`. Every method that
   * is not a GET is listed with the change it makes, as `read` when it only reads,
   * or with why it is not offered; GET methods are offered unless listed as hidden.
   */
  operations: Record<string, Change | "read" | Hidden>;
  /**
   * The OAuth scopes to request, when the smallest covering set would choose a
   * broader one, such as Drive's for Sheets. Every offered method must accept one.
   */
  scopes?: readonly string[] | undefined;
  /**
   * Parameters a method needs although its description does not mark them
   * required, by method ID, such as Sheets' `valueInputOption` for writes.
   */
  required?: Readonly<Record<string, readonly string[]>> | undefined;
  /**
   * Map fields, as `Schema.field`, whose entries may be null, which Google
   * documents in prose: Drive removes a file property set to null.
   */
  nullableValues?: readonly string[] | undefined;
}

/** The names the generated code uses for the template's service. */
export interface DiscoveryService {
  /** The service's name in documentation, such as `Gmail`. */
  name: string;
  /** The generated entrypoint class, such as `GmailApi`. */
  className: string;
  /** The result type in `src/results.ts`, such as `GmailResult`. */
  result: string;
  /** The props type in `src/run.ts`, such as `GmailProperties`. */
  properties: string;
}

const schema: z.ZodType<Schema> = z.lazy(() =>
  z.looseObject({
    $ref: z.string().optional(),
    type: z.string().optional(),
    format: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.string()).optional(),
    enumDescriptions: z.array(z.string()).optional(),
    items: schema.optional(),
    properties: z.record(z.string(), schema).optional(),
    additionalProperties: schema.optional(),
    readOnly: z.boolean().optional(),
    nullable: z.boolean().optional(),
    deprecated: z.boolean().optional(),
  }),
);

interface Schema {
  $ref?: string | undefined;
  type?: string | undefined;
  format?: string | undefined;
  description?: string | undefined;
  enum?: string[] | undefined;
  enumDescriptions?: string[] | undefined;
  items?: Schema | undefined;
  properties?: Record<string, Schema> | undefined;
  additionalProperties?: Schema | undefined;
  readOnly?: boolean | undefined;
  /** Set by the rules' `nullableValues`: null is a value, for example to remove an entry. */
  nullable?: boolean | undefined;
  deprecated?: boolean | undefined;
}

const parameter = z.looseObject({
  type: z.string().optional(),
  location: z.enum(["path", "query"]),
  required: z.boolean().optional(),
  repeated: z.boolean().optional(),
  default: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  deprecated: z.boolean().optional(),
});

const method = z.looseObject({
  id: z.string(),
  path: z.string(),
  httpMethod: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  description: z.string().optional(),
  parameters: z.record(z.string(), parameter).optional(),
  parameterOrder: z.array(z.string()).optional(),
  request: z.object({ $ref: z.string() }).optional(),
  response: z.object({ $ref: z.string() }).optional(),
  scopes: z.array(z.string()).optional(),
  deprecated: z.boolean().optional(),
  supportsMediaDownload: z.boolean().optional(),
  mediaUpload: z
    .looseObject({
      protocols: z.looseObject({
        simple: z.looseObject({ path: z.string(), multipart: z.boolean().optional() }).optional(),
      }),
    })
    .optional(),
});

type Method = z.infer<typeof method>;

type Resource = {
  methods?: Record<string, Method> | undefined;
  resources?: Record<string, Resource> | undefined;
};

const resource: z.ZodType<Resource> = z.lazy(() =>
  z.looseObject({
    methods: z.record(z.string(), method).optional(),
    resources: z.record(z.string(), resource).optional(),
  }),
);

const document = z.looseObject({
  rootUrl: z.url(),
  servicePath: z.string(),
  schemas: z.record(z.string(), schema),
  resources: z.record(z.string(), resource),
});

/** How the runtime calls one method: its HTTP request and the change it makes. */
export type DiscoveryOperation = {
  httpMethod: string;
  path: string;
  pathParameters: Record<string, string | null>;
  queryParameters: string[];
  /** Query parameters the method needs. */
  requiredParameters: string[];
  body: boolean;
  /** A JSON result, the file's content, or none. */
  response: "json" | "content" | null;
  /** Whether `alt=media` asks for the content instead of the metadata. */
  altMedia: boolean;
  /** The path that receives an upload of metadata and content, for `...WithContent` methods. */
  upload: string | null;
  change: Change | null;
};

// A parameter as the schema its value has.
const parameterSchema = (value: z.infer<typeof parameter>): Schema => ({
  type: value.type,
  enum: value.enum,
  description: value.description,
});

// TypeScript for a Discovery schema. 64-bit integers and bytes travel as strings.
const typeOf = (value: Schema, indent: string): string =>
  value.nullable ? `${valueType(value, indent)} | null` : valueType(value, indent);

const valueType = (value: Schema, indent: string): string => {
  if (value.$ref) return identifier(value.$ref);

  if (value.enum) return value.enum.map((entry) => JSON.stringify(entry)).join(" | ");

  switch (value.type) {
    case "integer":
    case "number":
      return value.format === "int64" || value.format === "uint64" ? "string" : "number";
    case "boolean":
      return "boolean";
    case "any":
      return "JsonValue";
    case "array": {
      const item = typeOf(value.items ?? { type: "any" }, indent);

      return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
    }

    case "object":
      return objectType(value, indent);
    default:
      return "string";
  }
};

const enumComment = (value: Schema) =>
  value.enum && value.enumDescriptions?.some(Boolean)
    ? value.enum
        .map((entry, index) => `- \`${entry}\`: ${value.enumDescriptions?.[index] ?? ""}`)
        .join("\n")
    : "";

const describe = (value: Schema) =>
  [value.description, enumComment(value), value.readOnly ? "Output only." : ""]
    .filter(Boolean)
    .join("\n\n");

// Google omits fields it has no value for, so every field is optional.
const objectType = (value: Schema, indent: string): string => {
  const fields = Object.entries(value.properties ?? {})
    .filter(([, field]) => !field.deprecated)
    .map(
      ([name, field]) =>
        `${comment(describe(field), `${indent}  `)}${indent}  ${propertyName(name)}?: ${typeOf(field, `${indent}  `)};`,
    );

  if (value.additionalProperties)
    fields.push(`${indent}  [key: string]: ${typeOf(value.additionalProperties, `${indent}  `)};`);

  return fields.length ? `{\n${fields.join("\n")}\n${indent}}` : "JsonObject";
};

// Methods by their resource path: `users.messages.send` is `usersMessagesSend`. A
// first resource every method shares, such as Gmail's `users`, is left out.
const methodNames = (methods: Method[]) => {
  const paths = methods.map((entry) => entry.id.split(".").slice(1));
  const first = paths[0]?.[0];
  const shared = paths.every((parts) => parts.length >= 2 && parts[0] === first);

  return paths.map((path) => {
    const parts = path.slice(shared ? 1 : 0);

    return parts
      .map((part, position) =>
        position === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
      )
      .join("");
  });
};

const collect = (resources: Record<string, Resource>): Method[] =>
  Object.values(resources).flatMap((entry) => [
    ...Object.values(entry.methods ?? {}),
    ...collect(entry.resources ?? {}),
  ]);

// A smallest set of scopes that authorizes every offered method, preferring the
// scopes that authorize the most methods.
const coveringScopes = (methods: Method[]) => {
  const chosen: string[] = [];
  let open = methods.filter((entry) => entry.scopes?.length);

  while (open.length) {
    const counts = new Map<string, number>();

    for (const entry of open)
      for (const scope of entry.scopes ?? []) counts.set(scope, (counts.get(scope) ?? 0) + 1);

    const [best] = [...counts].toSorted(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    );

    if (!best) break;
    chosen.push(best[0]);
    open = open.filter((entry) => !entry.scopes?.includes(best[0]));
  }

  return chosen;
};

const changes = z.enum(["create", "update", "delete", "send"]);

export const generateDiscovery = (
  source: string,
  { operations, scopes, required: requiredByRules = {}, nullableValues = [] }: DiscoveryRules,
  service: DiscoveryService,
  header: string,
): GeneratedFiles => {
  const api = document.parse(JSON.parse(source));
  const problems: string[] = [];

  for (const path of nullableValues) {
    const [schemaName = "", field = ""] = path.split(".");
    const entries = api.schemas[schemaName]?.properties?.[field]?.additionalProperties;

    if (entries) entries.nullable = true;
    else problems.push(`The rules name map field ${path}, which the API does not have`);
  }

  const all = collect(api.resources).filter((entry) => !entry.deprecated);
  const rules = new Map(Object.entries(operations));

  for (const id of rules.keys())
    if (!all.some((entry) => entry.id === id))
      problems.push(`The rules list ${id}, which the API no longer offers`);

  for (const [id, names] of Object.entries(requiredByRules))
    for (const name of names)
      if (!all.some((entry) => entry.id === id && entry.parameters?.[name]))
        problems.push(`The rules require ${id}'s parameter ${name}, which it no longer has`);

  const offered = all.filter((entry) => {
    const rule = rules.get(entry.id);

    if (rule === undefined && entry.httpMethod !== "GET")
      problems.push(
        `${entry.httpMethod} ${entry.id} is new; add it to the rules: ${entry.description?.split("\n")[0] ?? ""}`,
      );

    return rule === undefined
      ? entry.httpMethod === "GET"
      : rule === "read" || changes.safeParse(rule).success;
  });

  const names = methodNames(offered);

  // Methods that read file content get a `...Content` method, or return the
  // content when they have no other result; methods that accept uploads get a
  // `...WithContent` method that sends metadata and content together.
  const specs = offered.flatMap((entry, index) => {
    const name = names[index] ?? entry.id;

    const upload = entry.mediaUpload?.protocols.simple?.multipart
      ? entry.mediaUpload.protocols.simple.path
      : null;

    return [
      {
        entry,
        name,
        variant: entry.supportsMediaDownload && !entry.response ? "content" : "plain",
      },
      ...(entry.supportsMediaDownload && entry.response
        ? [{ entry, name: `${name}Content`, variant: "content" }]
        : []),
      ...(upload ? [{ entry, name: `${name}WithContent`, variant: "upload" }] : []),
    ] as const;
  });

  const taken = new Set<string>();

  for (const { entry, name } of specs) {
    if (reservedMethod(name) || taken.has(name))
      problems.push(`${entry.id} becomes method ${name}, which is taken`);
    taken.add(name);
  }

  for (const entry of offered)
    if (scopes && entry.scopes?.length && !entry.scopes.some((scope) => scopes.includes(scope)))
      problems.push(`${entry.id} needs one of the scopes ${entry.scopes.join(", ")}`);

  if (problems.length) throw new Error(problems.join("\n"));
  checkTypeNames(Object.keys(api.schemas).map(identifier), service);

  const models = Object.entries(api.schemas)
    .toSorted(([left], [right]) => left.localeCompare(right, "en"))
    .map(([name, value]) => {
      const body = typeOf({ ...value, $ref: undefined }, "");

      // Type aliases, not interfaces: request bodies use the same types and must be JSON values.
      return `${comment(describe(value))}export type ${identifier(name)} = ${body};\n`;
    })
    .join("\n");

  const runtime: Record<string, DiscoveryOperation> = {};

  const methods = specs.map(({ entry, name, variant }) => {
    const rule = rules.get(entry.id);
    const change = rule === undefined || rule === "read" ? null : changes.parse(rule);

    const parameters = Object.entries(entry.parameters ?? {})
      .filter(([, value]) => !value.deprecated)
      .map(([key, value]) =>
        requiredByRules[entry.id]?.includes(key)
          ? ([key, { ...value, required: true }] as const)
          : ([key, value] as const),
      );

    runtime[name] = {
      httpMethod: entry.httpMethod,
      path: entry.path,
      pathParameters: Object.fromEntries(
        parameters
          .filter(([, value]) => value.location === "path")
          .map(([key, value]) => [key, value.default ?? null]),
      ),
      queryParameters: parameters
        .filter(([, value]) => value.location === "query")
        .map(([key]) => key),
      requiredParameters: parameters
        .filter(
          ([, value]) =>
            value.location === "query" && value.required && value.default === undefined,
        )
        .map(([key]) => key),
      body: entry.request !== undefined,
      response: variant === "content" ? "content" : entry.response ? "json" : null,
      altMedia: variant === "content" && entry.response !== undefined,
      upload: variant === "upload" ? (entry.mediaUpload?.protocols.simple?.path ?? null) : null,
      change,
    };

    const fields = parameters.map(([key, value]) => {
      const single = typeOf(parameterSchema(value), "    ");
      const item = single.includes(" | ") ? `(${single})` : single;
      const type = value.repeated ? `${item}[]` : single;
      const optional = !value.required || value.default !== undefined;

      return `${comment(describe(parameterSchema(value)), "    ")}    ${propertyName(key)}${optional ? "?" : ""}: ${type};`;
    });

    if (entry.request)
      fields.push(
        variant === "upload"
          ? `    /** The file's metadata. */\n    body?: ${identifier(entry.request.$ref)};`
          : `    /** The request body. */\n    body: ${identifier(entry.request.$ref)};`,
      );

    if (variant === "upload")
      fields.push(`    /** The file's content, as text or base64. */\n    content: UploadContent;`);

    const input = fields.length ? `{\n${fields.join("\n")}\n  }` : "Record<string, never>";

    const approval =
      change === null
        ? ""
        : change === "create"
          ? "Asks the user first when their approval level is `all_changes`."
          : "Asks the user first unless their approval level is `none`.";

    const argumentDocs = parameters.map(
      ([key, value]) =>
        `- \`${key}\`${value.description ? `: ${value.description.replace(/\s*\n\s*/g, " ")}` : ""}`,
    );

    if (entry.request)
      argumentDocs.push(
        variant === "upload"
          ? `- \`body\`: The file's metadata, a \`${entry.request.$ref}\`.`
          : `- \`body\`: The request body, a \`${entry.request.$ref}\`.`,
      );

    if (variant === "upload")
      argumentDocs.push(
        "- `content`: The file's content: its `mimeType`, and `text` or `base64` bytes.",
      );

    const target = variant === "content" ? undefined : entry.response?.$ref;

    const media =
      variant === "content"
        ? "Returns the file's content, up to 8 MiB."
        : variant === "upload"
          ? "Sends the metadata and the content in one upload."
          : "";

    const tags = [
      argumentDocs.length
        ? `@param input - The arguments:\n${argumentDocs.join("\n")}`
        : "@param input - No arguments: pass `{}`.",
      target ? `@param select - The fields of \`${target}\` to return.` : "",
    ].filter(Boolean);

    const description = comment(
      [entry.description, media, approval, tags.join("\n")].filter(Boolean).join("\n\n"),
      "  ",
    );

    const call = `run(this.env, this.ctx.props, ${JSON.stringify(name)}, input${target ? ", select" : ""})`;

    const required =
      (entry.request !== undefined && variant !== "content") ||
      variant === "upload" ||
      parameters.some(([, value]) => value.required && value.default === undefined);

    const inputParameter = `input: ${input}${required ? "" : " = {}"}`;

    if (target)
      return `${description}  async ${name}<S extends Selection<${identifier(target)}>>(${inputParameter}, select: S & Exact<S, Selection<${identifier(target)}>>): Promise<${service.result}<ValueResult<${identifier(target)}, S>>> {\n    return ${call};\n  }\n`;

    return `${description}  async ${name}(${inputParameter}): Promise<${service.result}<${variant === "content" ? "BinaryContent" : "null"}>> {\n    return ${call};\n  }\n`;
  });

  const contentImports = ["BinaryContent", "UploadContent"].filter((name) =>
    specs.some(({ variant }) => variant === (name === "BinaryContent" ? "content" : "upload")),
  );

  return {
    files: {
      "src/api.ts": `${header}import { WorkerEntrypoint } from "cloudflare:workers";
import type { Environment as TemplateEnvironment } from "./context.ts";
${contentImports.length ? `import type { ${contentImports.join(", ")} } from "./content.ts";\n` : ""}import type { ${service.result} } from "./results.ts";
import { type ${service.properties}, run } from "./run.ts";
import type { Exact, ${["JsonObject", "JsonValue"]
        .flatMap((used) => (new RegExp(`\\b${used}\\b`).test(models) ? [`${used}, `] : []))
        .join("")}Selection, ValueResult } from "./selection.ts";

${models}
/**
 * Every method of the ${service.name} API that a user's account can use. Methods
 * that change data may ask the user first. Methods returning objects take a
 * selection of the fields to return.
 */
export class ${service.className} extends WorkerEntrypoint<TemplateEnvironment, ${service.properties}> {
${methods.join("\n")}}
`,
      "src/schema.ts": `${header}
/** How the runtime calls a method: its HTTP request and the change it makes. */
export type Operation = {
  httpMethod: string;
  path: string;
  /** Path parameters and their defaults. */
  pathParameters: Record<string, string | null>;
  queryParameters: string[];
  requiredParameters: string[];
  body: boolean;
  response: "json" | "content" | null;
  altMedia: boolean;
  upload: string | null;
  change: "create" | "update" | "delete" | "send" | null;
};

/** The API's address, which each method's path extends. */
export const base = ${JSON.stringify(new URL(api.servicePath, api.rootUrl).href)};

export const operations = ${JSON.stringify(runtime)} satisfies Record<string, Operation>;

/** OAuth scopes that authorize every offered method. */
export const scopes = ${JSON.stringify(scopes ?? coveringScopes(offered))};
`,
    },
    summary: `${methods.length} methods, ${all.length - offered.length} not offered, ${Object.keys(api.schemas).length} types`,
  };
};
