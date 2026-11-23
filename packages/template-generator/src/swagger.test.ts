import { describe, expect, it } from "vitest";
import { generateOpenapi } from "./openapi.ts";
import { bundleReferences, localCopy } from "./references.ts";
import type { Json } from "./rules.ts";
import { upgradeSwagger } from "./swagger.ts";

// A Swagger 2.0 description in the shape Strava publishes, with its schemas in
// sibling files.
const api = {
  swagger: "2.0",
  host: "api.example.test",
  basePath: "/v3",
  schemes: ["https"],
  produces: ["application/json"],
  parameters: {
    page: { name: "page", in: "query", type: "integer" },
  },
  paths: {
    "/activities": {
      get: {
        operationId: "listActivities",
        parameters: [
          { $ref: "#/parameters/page" },
          {
            name: "keys",
            in: "query",
            type: "array",
            items: { type: "string", enum: ["time", "distance"] },
          },
          {
            name: "tags",
            in: "query",
            type: "array",
            items: { type: "string" },
            collectionFormat: "multi",
          },
        ],
        responses: {
          "200": {
            description: "The activities.",
            schema: {
              type: "array",
              items: { $ref: "https://api.example.test/swagger/activity.json#/Activity" },
            },
          },
          default: {
            description: "Error",
            schema: { $ref: "https://api.example.test/swagger/fault.json#/Fault" },
          },
        },
      },
      post: {
        operationId: "createActivity",
        parameters: [
          { name: "name", in: "formData", type: "string", required: true },
          { name: "elapsed_time", in: "formData", type: "integer", description: "In seconds." },
        ],
        responses: {
          "201": {
            description: "Created.",
            schema: { $ref: "https://api.example.test/swagger/activity.json#/Activity" },
          },
        },
      },
    },
    "/activities/{id}": {
      put: {
        operationId: "updateActivity",
        parameters: [
          { name: "id", in: "path", required: true, type: "integer", format: "int64" },
          {
            name: "body",
            in: "body",
            schema: { $ref: "https://api.example.test/swagger/activity.json#/Activity" },
          },
        ],
        responses: {
          "200": {
            description: "Updated.",
            schema: { $ref: "https://api.example.test/swagger/activity.json#/Activity" },
          },
        },
      },
    },
    "/uploads": {
      post: {
        operationId: "createUpload",
        consumes: ["multipart/form-data"],
        parameters: [
          { name: "file", in: "formData", type: "file" },
          { name: "data_type", in: "formData", type: "string", enum: ["gpx", "fit"] },
        ],
        responses: { "201": { description: "Uploaded." } },
      },
    },
    "/routes/{id}/export": {
      get: {
        operationId: "exportRoute",
        parameters: [{ name: "id", in: "path", required: true, type: "integer" }],
        responses: { "200": { description: "The file.", schema: { type: "file" } } },
      },
    },
    "/athlete": {
      put: {
        operationId: "updateAthlete",
        parameters: [{ name: "weight", in: "path", required: true, type: "number" }],
        responses: { "200": { description: "Updated." } },
      },
    },
  },
};

const files = {
  "https://api.example.test/swagger/activity.json": {
    Activity: {
      type: "object",
      properties: {
        id: { type: "integer", format: "int64" },
        name: { type: "string" },
        athlete: { $ref: "https://api.example.test/swagger/athlete.json#/Athlete" },
        laps: { type: "array", items: { $ref: "#/Lap" } },
      },
    },
    Lap: { type: "object", properties: { elapsed_time: { type: "integer" } } },
  },
  "https://api.example.test/swagger/athlete.json": {
    Athlete: {
      type: "object",
      properties: { id: { type: "integer" }, clubs: { type: "array", items: { $ref: "#/Club" } } },
    },
    Club: { type: "object", properties: { name: { type: "string" } } },
  },
  "https://api.example.test/swagger/fault.json": {
    Fault: { type: "object", properties: { message: { type: "string" } } },
  },
} satisfies Record<string, Json>;

const loaded: string[] = [];

const sources = new Map<string, Json>(Object.entries(files));

const load = async (url: string) => {
  loaded.push(url);
  const found = sources.get(url);

  if (!found) throw new Error(`No file at ${url}`);

  return found;
};

const service = {
  name: "Example",
  className: "ExampleApi",
  result: "ExampleResult",
  properties: "ExampleProperties",
};

const rules = {
  operations: {
    listActivities: { name: "listActivities" },
    createActivity: { name: "createActivity", change: "send" },
    updateActivity: { name: "updateActivity", change: "update" },
    createUpload: { name: "createUpload", change: "send" },
    exportRoute: { name: "exportRoute" },
  },
} as const;

const source = "https://api.example.test/swagger/swagger.json";

describe("Swagger descriptions", () => {
  it("brings the schemas of sibling files in once, with references inside them resolved there", async () => {
    loaded.length = 0;
    const bundled = await bundleReferences(api, source, load);

    expect(bundled).toMatchObject({
      definitions: {
        Activity: {
          properties: {
            athlete: { $ref: "#/definitions/Athlete" },
            laps: { items: { $ref: "#/definitions/Lap" } },
          },
        },
        Lap: { type: "object" },
        Athlete: { properties: { clubs: { items: { $ref: "#/definitions/Club" } } } },
        Club: { type: "object" },
        Fault: { type: "object" },
      },
      parameters: { page: { name: "page" } },
    });
    expect(JSON.stringify(bundled)).not.toContain("https://api.example.test/swagger/");
    // Each file is read once.
    expect(loaded.toSorted()).toEqual(Object.keys(files).toSorted());
    // A description in one file stays as it is.
    expect(
      await bundleReferences(files["https://api.example.test/swagger/fault.json"], source, load),
    ).toBe(files["https://api.example.test/swagger/fault.json"]);
  });

  it("stops when two files name different schemas alike", async () => {
    const clashing = {
      ...api,
      definitions: { Fault: { type: "object" } },
    };

    await expect(bundleReferences(clashing, source, load)).rejects.toThrow(
      "https://api.example.test/swagger/fault.json#/Fault would take the schema name Fault, which is taken",
    );
  });

  it("reads Swagger 2.0 as OpenAPI 3: server, list formats, form and multipart bodies and files", async () => {
    const { files: generated, summary } = generateOpenapi(
      await bundleReferences(api, source, load),
      rules,
      service,
      "",
    );

    const types = generated["src/api.ts"] ?? "";
    const schema = generated["src/schema.ts"] ?? "";

    expect(summary).toBe("5 methods of 6 operations, 4 types");
    expect(schema).toContain('export const base = "https://api.example.test/v3/";');
    // Lists are comma-separated unless the parameter says `multi`.
    expect(schema).toContain(
      '"queryParameters":{"page":["page",null,false],"keys":["keys",",",false],"tags":["tags",null,false]}',
    );
    expect(types).toContain('keys?: ("time" | "distance")[];');
    // Form fields are a form body, and file fields a multipart one.
    expect(schema).toContain('"createActivity":{"httpMethod":"POST","path":"/activities"');
    expect(schema).toMatch(
      /"createActivity":\{[^}]*\},"queryParameters":\{\},"headerParameters":\{\},"body":"form","bodyRequired":true/,
    );
    expect(types).toMatch(
      /body: \{\n(?:.*\n)*?\s+name: string;\n(?:.*\n)*?\s+elapsed_time\?: number;/,
    );
    expect(schema).toContain('"body":"multipart","bodyRequired":false,"response":null');
    expect(types).toContain("file?: UploadContent;");
    expect(types).toContain('import type { BinaryContent, UploadContent } from "./content.ts";');
    // A JSON body and the answers' schemas, from the sibling files.
    expect(schema).toContain('"body":"json","bodyRequired":false,"response":"json"');
    expect(types).toContain("body?: Activity;");
    expect(types).toContain("Promise<ExampleResult<Activity[]>>");
    expect(types).toContain("athlete?: Athlete;");
    // File answers are binary content.
    expect(types).toContain("async exportRoute(input: {");
    expect(types).toContain("Promise<ExampleResult<BinaryContent>>");
    // 64-bit IDs may be strings; other numbers stay numbers.
    expect(types).toContain("id: number | string;");
    expect(types).toMatch(/async exportRoute\(input: \{\n(?:.*\n)*?\s+id: number;/);
  });

  it("stops on path parameters the path has no place for", async () => {
    expect(() =>
      generateOpenapi(
        api,
        { operations: { updateAthlete: { name: "updateAthlete", change: "update" } } },
        service,
        "",
      ),
    ).toThrow("updateAthlete's path parameter weight has no place in its path /athlete");
  });
});

// A small Swagger 2.0 description for one operation.
const single = (path: string, method: string, operation: Json) => ({
  swagger: "2.0",
  host: "api.example.test",
  paths: { [path]: { [method]: operation } },
});

const schemaOf = (description: Json, rules: Parameters<typeof generateOpenapi>[1]) =>
  generateOpenapi(description, rules, service, "").files["src/schema.ts"] ?? "";

describe("Swagger lists, paths and references", () => {
  it("joins query and form lists as their format says", () => {
    const lists = (place: "query" | "formData") =>
      single("/items", place === "query" ? "get" : "post", {
        operationId: "items",
        parameters: [
          ...["csv", "ssv", "pipes", "tsv", "multi"].map((format) => ({
            name: format,
            in: place,
            type: "array",
            items: { type: "string" },
            collectionFormat: format,
          })),
          // Swagger joins lists with commas unless they say otherwise.
          { name: "plain", in: place, type: "array", items: { type: "string" } },
        ],
        responses: { "204": { description: "Done." } },
      });

    expect(schemaOf(lists("query"), { operations: { items: { name: "items" } } })).toContain(
      '"queryParameters":{"csv":["csv",",",false],"ssv":["ssv"," ",false],"pipes":["pipes","|",false],"tsv":["tsv","\\t",false],"multi":["multi",null,false],"plain":["plain",",",false]}',
    );
    // Form lists join the same way; `multi` lists repeat the field.
    expect(
      schemaOf(lists("formData"), { operations: { items: { name: "items", change: "create" } } }),
    ).toContain(
      '"body":"form","bodyRequired":false,"response":null,"pageable":false,"change":"create","formLists":{"csv":",","ssv":" ","pipes":"|","tsv":"\\t","plain":","}',
    );
  });

  it("stops on places in a path that no parameter fills, unless a rule adds the parameter", () => {
    const routes = single("/athletes/{id}/routes", "get", {
      operationId: "listRoutes",
      parameters: [{ name: "page", in: "query", type: "integer" }],
      responses: { "200": { description: "The routes." } },
    });

    expect(() => schemaOf(routes, { operations: { listRoutes: { name: "listRoutes" } } })).toThrow(
      "listRoutes's path /athletes/{id}/routes has {id}, which no path parameter fills",
    );

    const { files } = generateOpenapi(
      routes,
      {
        operations: {
          listRoutes: {
            name: "listRoutes",
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                description: "The athlete.",
                schema: { type: "integer", format: "int64" },
              },
            ],
          },
        },
      },
      service,
      "",
    );

    expect(files["src/schema.ts"]).toContain('"pathParameters":{"id":"id"}');
    expect(files["src/api.ts"]).toMatch(/\* The athlete\.\n\s+\*\/\n\s+id: number \| string;/);
  });

  it("replaces, adds and removes form fields as the rules say", () => {
    const create = single("/activities", "post", {
      operationId: "createActivity",
      parameters: [
        { name: "name", in: "formData", type: "string", required: true },
        { name: "tags", in: "formData", type: "string", required: true },
      ],
      responses: { "201": { description: "Created." } },
    });

    const types =
      generateOpenapi(
        create,
        {
          operations: {
            createActivity: {
              name: "createActivity",
              change: "create",
              fields: { tags: null, "tags[WithPet]": { type: "boolean" } },
            },
          },
        },
        service,
        "",
      ).files["src/api.ts"] ?? "";

    expect(types).toContain('"tags[WithPet]"?: boolean;');
    expect(types).not.toMatch(/\btags[?:]/);
    expect(types).toContain("name: string;");
  });

  it("uploads the files of named multipart schemas and keeps strings in their answers", () => {
    const upload = {
      openapi: "3.0.3",
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/uploads": {
          post: {
            operationId: "createUpload",
            requestBody: {
              content: {
                "multipart/form-data": { schema: { $ref: "#/components/schemas/Upload" } },
              },
            },
            responses: {
              "201": {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Upload" } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Upload: {
            type: "object",
            properties: {
              file: { $ref: "#/components/schemas/File" },
              name: { type: "string" },
            },
          },
          File: { type: "string", format: "binary" },
        },
      },
    };

    const types =
      generateOpenapi(
        upload,
        { operations: { createUpload: { name: "createUpload", change: "create" } } },
        service,
        "",
      ).files["src/api.ts"] ?? "";

    expect(types).toMatch(/body\?: \{\n\s+file\?: UploadContent;\n\s+name\?: string;\n\s+\};/);
    expect(types).toContain("export type File = string;");
    expect(types).toContain("Promise<ExampleResult<Upload>>");
  });

  it("keeps references back to the description's schemas and names whole-file schemas", async () => {
    const root = {
      swagger: "2.0",
      host: "api.example.test",
      definitions: {
        Parent: {
          type: "object",
          properties: { child: { $ref: "https://api.example.test/swagger/child.json#/Child" } },
        },
      },
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            responses: { "200": { description: "Pets.", schema: { $ref: "pets/Pet.yaml" } } },
          },
        },
      },
    };

    const siblings = new Map<string, Json>([
      [
        "https://api.example.test/swagger/child.json",
        {
          Child: {
            type: "object",
            properties: {
              parent: { $ref: "https://api.example.test/swagger/swagger.json#/definitions/Parent" },
            },
          },
        },
      ],
      [
        "https://api.example.test/swagger/pets/Pet.yaml",
        {
          type: "object",
          properties: { tag: { $ref: "#/definitions/Tag" } },
          definitions: { Tag: { type: "string" } },
        },
      ],
    ]);

    const bundled = await bundleReferences(root, source, async (url) => {
      const found = siblings.get(url);

      if (!found) throw new Error(`No file at ${url}`);

      return found;
    });

    expect(bundled).toMatchObject({
      definitions: {
        Parent: { properties: { child: { $ref: "#/definitions/Child" } } },
        Child: { properties: { parent: { $ref: "#/definitions/Parent" } } },
        Pet: { properties: { tag: { $ref: "#/definitions/Tag" } } },
        Tag: { type: "string" },
      },
      paths: {
        "/pets": { get: { responses: { "200": { schema: { $ref: "#/definitions/Pet" } } } } },
      },
    });
  });
});

describe("Form shapes, local copies and literal data", () => {
  const formWith = (type: string) => ({
    openapi: "3.0.3",
    servers: [{ url: "https://api.example.test" }],
    paths: {
      "/uploads": {
        post: {
          operationId: "createUpload",
          requestBody: {
            content: {
              [type]: {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                    metadata: { type: "object", properties: { title: { type: "string" } } },
                  },
                },
              },
            },
          },
          responses: { "204": { description: "Done." } },
        },
      },
    },
  });

  const rules = {
    operations: { createUpload: { name: "createUpload", change: "create" } },
  } as const;

  it("types a multipart form's objects, which go as JSON parts, and refuses objects in plain forms", () => {
    expect(
      generateOpenapi(formWith("multipart/form-data"), rules, service, "").files["src/api.ts"],
    ).toMatch(/metadata\?: \{\n\s+title\?: string;\n\s+\};/);
    expect(() =>
      generateOpenapi(formWith("application/x-www-form-urlencoded"), rules, service, ""),
    ).toThrow("createUpload's form field metadata is an object, which a form cannot send");
  });

  it("checks only the body it sends: JSON before an unused form", () => {
    const both = formWith("application/x-www-form-urlencoded");
    const { requestBody } = both.paths["/uploads"].post;

    const offered = {
      ...both,
      paths: {
        "/uploads": {
          post: {
            ...both.paths["/uploads"].post,
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { title: { type: "string" } } },
                },
                "application/x-www-form-urlencoded": {
                  ...requestBody.content["application/x-www-form-urlencoded"],
                  encoding: { metadata: { style: "deepObject" } },
                },
              },
            },
          },
        },
      },
    };

    const { files } = generateOpenapi(offered, rules, service, "");

    expect(files["src/schema.ts"]).toContain('"body":"json"');
    expect(files["src/api.ts"]).toMatch(/body\?: \{\n\s+title\?: string;\n\s+\};/);
    // A fields rule needs the form it changes to be the body that is sent.
    expect(() =>
      generateOpenapi(
        offered,
        {
          operations: {
            createUpload: { name: "createUpload", change: "create", fields: { title: null } },
          },
        },
        service,
        "",
      ),
    ).toThrow("createUpload's fields rule needs a form body that lists its fields");
  });

  it("finds referred files beside a local copy, decoded and in parent folders", () => {
    const source = "https://api.example.test/specs/v3/swagger.json";
    const file = "/work/strava/swagger.json";

    expect(localCopy("https://api.example.test/specs/v3/Pet%20Details.json", source, file)).toBe(
      "/work/strava/Pet Details.json",
    );
    expect(localCopy("https://api.example.test/specs/shared/x.json", source, file)).toBe(
      "/work/shared/x.json",
    );
    expect(localCopy("https://other.example.test/specs/v3/x.json", source, file)).toBeNull();
  });

  it("leaves references in examples, defaults, enums, constants and extensions as data", async () => {
    const description = {
      swagger: "2.0",
      host: "api.example.test",
      definitions: {
        Model: {
          type: "object",
          example: { $ref: "https://example.test/model" },
          default: { $ref: "#/definitions/Model" },
          "x-sample": { $ref: "https://example.test/sample" },
          properties: {
            kind: { type: "string", enum: [{ $ref: "https://example.test/kind" }] },
            // A property named like a keyword is still a schema.
            example: { $ref: "https://api.example.test/swagger/child.json#/Child" },
          },
        },
      },
      paths: {},
    };

    const bundled = await bundleReferences(description, source, async (url) => {
      if (url !== "https://api.example.test/swagger/child.json") throw new Error(`Loaded ${url}`);

      return { Child: { type: "string" } };
    });

    expect(bundled).toMatchObject({
      definitions: {
        Model: {
          example: { $ref: "https://example.test/model" },
          "x-sample": { $ref: "https://example.test/sample" },
          properties: {
            kind: { enum: [{ $ref: "https://example.test/kind" }] },
            example: { $ref: "#/definitions/Child" },
          },
        },
        Child: { type: "string" },
      },
    });
    // The upgrade moves references to schemas, but not those inside data.
    expect(upgradeSwagger(bundled)).toMatchObject({
      components: {
        schemas: {
          Model: {
            default: { $ref: "#/definitions/Model" },
            properties: { example: { $ref: "#/components/schemas/Child" } },
          },
        },
      },
    });
  });
});
