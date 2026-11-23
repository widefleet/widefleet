import { describe, expect, it } from "vitest";
import { generateOpenapi } from "./openapi.ts";
import { bundleReferences } from "./references.ts";
import type { Json } from "./rules.ts";

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
