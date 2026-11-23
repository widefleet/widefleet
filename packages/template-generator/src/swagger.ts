// Reads Swagger 2.0 descriptions as the OpenAPI 3 documents the OpenAPI
// generator reads. Some providers, such as Strava, publish only Swagger 2.0.
// The upgrade covers what the generator uses: the server address, schemas,
// path and query parameters with their list formats, JSON and form bodies, and
// the content of answers.
import { z } from "zod";
import { json, type Json, jsonEntries, jsonObject, type JsonObject } from "./rules.ts";

const parameter = z.looseObject({
  name: z.string(),
  in: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  schema: json.optional(),
  type: z.string().optional(),
  collectionFormat: z.string().optional(),
});

type Parameter = z.infer<typeof parameter>;

const response = z.looseObject({
  description: z.string().optional(),
  schema: json.optional(),
  content: json.optional(),
});

const operation = z.looseObject({
  parameters: z.array(json).optional(),
  responses: z.record(z.string(), json).optional(),
  consumes: z.array(z.string()).optional(),
  produces: z.array(z.string()).optional(),
});

const swagger = z.looseObject({
  swagger: z.literal("2.0"),
  info: json.optional(),
  host: z.string(),
  basePath: z.string().optional(),
  schemes: z.array(z.string()).optional(),
  consumes: z.array(z.string()).optional(),
  produces: z.array(z.string()).optional(),
  paths: z.record(z.string(), jsonObject),
  definitions: jsonObject.optional(),
  parameters: z.record(z.string(), parameter).optional(),
  responses: z.record(z.string(), response).optional(),
});

/** Whether a parsed description is a Swagger 2.0 document. */
export const isSwagger = (description: Json) =>
  z.object({ swagger: z.literal("2.0") }).safeParse(description).success;

const methods = ["get", "put", "post", "patch", "delete"];

// The parts of a parameter that describe its value.
const valueKeys = [
  "type",
  "format",
  "items",
  "enum",
  "default",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
];

// Lists in queries are comma-separated unless the parameter says otherwise.
const listStyles = {
  csv: { style: "form", explode: false },
  ssv: { style: "spaceDelimited", explode: false },
  pipes: { style: "pipeDelimited", explode: false },
  multi: { style: "form", explode: true },
  tsv: { style: "tabDelimited", explode: false },
};

const listStyle = z.enum(["csv", "ssv", "pipes", "multi", "tsv"]);

// References to definitions become references to OpenAPI 3's schemas, at every depth.
const moved = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(moved);
  const entries = jsonEntries(value);

  if (!entries) return value;

  return Object.fromEntries(
    entries.map(([key, entry]) => {
      const ref = z.string().safeParse(entry);

      return [
        key,
        key === "$ref" && ref.success
          ? ref.data.replace(/^#\/definitions\//, "#/components/schemas/")
          : moved(entry),
      ];
    }),
  );
};

// The schema of a parameter's value. Swagger's file type is binary content in OpenAPI 3.
const valueSchema = (value: Parameter) => {
  const schema: JsonObject = {};

  for (const [key, entry] of Object.entries(jsonObject.parse(value)))
    if (valueKeys.includes(key)) schema[key] = moved(entry);

  if (value.type === "file") Object.assign(schema, { type: "string", format: "binary" });

  if (value.description) schema["description"] = value.description;

  return schema;
};

/** The OpenAPI 3 form of a Swagger 2.0 description. */
export const upgradeSwagger = (description: Json): Json => {
  const api = swagger.parse(description);

  // Shared parameters and answers are written into each operation that names them.
  const sharedParameter = (value: Json) => {
    const ref = z.object({ $ref: z.string() }).safeParse(value);

    if (!ref.success) return parameter.parse(value);
    const found = api.parameters?.[ref.data.$ref.replace("#/parameters/", "")];

    if (!found) throw new Error(`${ref.data.$ref} is not described`);

    return found;
  };

  const sharedResponse = (value: Json) => {
    const ref = z.object({ $ref: z.string() }).safeParse(value);

    if (!ref.success) return response.parse(value);
    const found = api.responses?.[ref.data.$ref.replace("#/responses/", "")];

    if (!found) throw new Error(`${ref.data.$ref} is not described`);

    return found;
  };

  // A query or path parameter, with the list format of a query list as its style.
  const valueParameter = (value: Parameter) => {
    const upgraded: JsonObject = { name: value.name, in: value.in, schema: valueSchema(value) };

    if (value.description) upgraded["description"] = value.description;

    if (value.required !== undefined) upgraded["required"] = value.required;

    if (value.type === "array" && value.in === "query") {
      const format = listStyle.safeParse(value.collectionFormat ?? "csv");
      Object.assign(
        upgraded,
        format.success ? listStyles[format.data] : { style: value.collectionFormat ?? "" },
      );
    }

    return upgraded;
  };

  // A body parameter's schema, or form fields as an object, by media type.
  const requestBody = (parameters: Parameter[], consumes: string[]) => {
    const body = parameters.find((value) => value.in === "body");

    if (body) {
      const upgraded: JsonObject = {
        required: body.required === true,
        content: Object.fromEntries(
          (consumes.length ? consumes : ["application/json"]).map((type) => [
            type,
            { schema: moved(body.schema ?? {}) },
          ]),
        ),
      };

      if (body.description) upgraded["description"] = body.description;

      return upgraded;
    }

    const form = parameters.filter((value) => value.in === "formData");

    if (!form.length) return null;

    // Form fields are sent as a form, or as multipart when they carry files.
    const type =
      form.some((value) => value.type === "file") ||
      (consumes.includes("multipart/form-data") &&
        !consumes.includes("application/x-www-form-urlencoded"))
        ? "multipart/form-data"
        : "application/x-www-form-urlencoded";

    return {
      required: form.some((value) => value.required),
      content: {
        [type]: {
          schema: {
            type: "object",
            properties: Object.fromEntries(form.map((value) => [value.name, valueSchema(value)])),
            required: form.flatMap((value) => (value.required ? [value.name] : [])),
          },
        },
      },
    };
  };

  // Answers without a schema have no content; files are binary content.
  const answer = (value: Json, produces: string[]) => {
    const { schema, content, ...rest } = sharedResponse(value);
    const upgraded = jsonObject.parse(rest);
    const file = z.object({ type: z.literal("file") }).safeParse(schema).success;

    if (content !== undefined) upgraded["content"] = moved(content);
    else if (schema !== undefined)
      upgraded["content"] = Object.fromEntries(
        (file ? ["application/octet-stream"] : produces).map((type) => [
          type,
          { schema: file ? { type: "string", format: "binary" } : moved(schema) },
        ]),
      );

    return upgraded;
  };

  const scheme = api.schemes?.includes("https") ? "https" : (api.schemes?.[0] ?? "https");

  const paths = Object.fromEntries(
    Object.entries(api.paths).map(([path, item]) => {
      const common = z.array(json).optional().parse(item["parameters"]) ?? [];
      const upgraded: JsonObject = {};

      for (const method of methods) {
        const value = item[method];

        if (value === undefined) continue;
        const entry = operation.parse(value);

        // An operation's parameter replaces the path's parameter of the same name and place.
        const parameters = [
          ...new Map(
            [...common, ...(entry.parameters ?? [])].map((declared) => {
              const resolved = sharedParameter(declared);

              return [`${resolved.in}:${resolved.name}`, resolved] as const;
            }),
          ).values(),
        ];

        // Parameters, bodies and media types take their OpenAPI 3 places.
        const kept: JsonObject = {};

        for (const [key, field] of Object.entries(jsonObject.parse(value)))
          if (!["parameters", "consumes", "produces", "responses"].includes(key)) kept[key] = field;

        kept["parameters"] = parameters.flatMap((declared) =>
          declared.in === "body" || declared.in === "formData" ? [] : [valueParameter(declared)],
        );

        const body = requestBody(parameters, entry.consumes ?? api.consumes ?? []);

        if (body) kept["requestBody"] = body;
        const produces = entry.produces ?? api.produces ?? ["application/json"];

        kept["responses"] = Object.fromEntries(
          Object.entries(entry.responses ?? {}).map(([code, declared]) => [
            code,
            answer(declared, produces),
          ]),
        );

        upgraded[method] = kept;
      }

      return [path, upgraded];
    }),
  );

  const servers = [{ url: `${scheme}://${api.host}${api.basePath ?? ""}` }];
  const components = { schemas: moved(api.definitions ?? {}) };

  return api.info === undefined
    ? { openapi: "3.0.3", servers, paths, components }
    : { openapi: "3.0.3", info: api.info, servers, paths, components };
};
