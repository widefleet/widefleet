import * as contract from "@platform/contracts";
import { bundleResult, documentRequest } from "@platform/contracts/builds";
import { Result } from "better-result";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApi } from "../src/lib/server/api.ts";
import { createAppBuilder } from "../src/lib/server/app-builder.ts";
import { createRuntime, type Runtime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createTestEnvironment } from "./environment.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";
import { templateRepository } from "./template-repository.fixture.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

const originalFetch = globalThis.fetch;

const worker = 'export default { fetch: () => new Response("Hello") };\n';

const map = JSON.stringify({ version: 3, sources: ["src/app.ts"], names: [], mappings: "" });

const mapName = `map-${"a".repeat(64)}.map`;

const documentation = {
  format: 1,
  entrypoints: [
    {
      name: "default",
      summary: "",
      remarks: "",
      examples: [],
      http: true,
      methods: [
        {
          name: "connectionStatus",
          summary: "Check the connection.",
          remarks: "",
          examples: [],
          throws: [],
          signatures: [
            {
              parameters: [],
              returns: { type: "Promise<{ status: string; }>", description: "" },
            },
          ],
        },
      ],
    },
  ],
  types: [],
};

const builderRequests: { phase: "bundle" | "document"; body: string }[] = [];

let bundleResponse = () =>
  Response.json(
    bundleResult.parse({
      worker,
      map,
      entry: "src/app.ts",
      metadata: {
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        bindings: [{ type: "d1", name: "DB", database_name: "accounts" }],
        debug: { build_id: "b".repeat(64), source_maps: { "worker.js": mapName } },
        web: true,
        entrypoints: ["default"],
        crons: [],
        queue_consumers: [],
      },
      warnings: ["A bundling note"],
    }),
  );

// A builder that records its requests and returns a fixed build.
const builder = createAppBuilder({
  bundle: async (body) => {
    builderRequests.push({ phase: "bundle", body });

    return bundleResponse();
  },
  document: async (body) => {
    builderRequests.push({ phase: "document", body });

    return Response.json({ documentation, warnings: [] });
  },
});

const runtimes: Runtime[] = [];

const runtimeWith = async (appBuilder?: typeof builder) => {
  const options: Parameters<typeof createRuntime>[0] = {
    configuration: environment.configuration,
    database: environment.database,
    settings: environment.settings,
    storage: createStorage(environment.configuration, memoryStorage()),
    reporting: environment.reporting,
    encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
  };

  if (appBuilder) options.builder = appBuilder;

  const runtime = await createRuntime(options)();

  vi.spyOn(runtime.identity, "authenticate").mockResolvedValue(
    Result.ok({
      ...environment.owner,
      role: "owner",
      admin: true,
      creator: true,
      application: environment.application,
    }),
  );
  runtimes.push(runtime);

  return runtime;
};

const install = (
  runtime: Runtime,
  template: string,
  body: Omit<z.input<typeof contract.templateInstallInput>, "templateId"> = {},
) =>
  createApi(runtime)(
    new Request(`http://localhost/api/v1/catalog/templates/${template}/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  environment = await createTestEnvironment();
});

beforeEach(() => {
  builderRequests.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    return (await templateRepository(url)) ?? originalFetch(input, init);
  });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => environment?.close());

it("builds a template's sources and deploys them as the CLI would", async () => {
  const runtime = await runtimeWith(builder);

  const template = await createApi(runtime)(
    new Request("http://localhost/api/v1/catalog/templates/gmail"),
  );

  expect(contract.appTemplate.parse(await template.json()).installable).toBe(true);

  const response = await install(runtime, "gmail", { name: "mail-reader" });

  expect(response.status).toBe(200);
  const result = contract.templateInstall.parse(await response.json());

  expect(result.app.slug).toBe("mail-reader");
  expect(result.deployment).toMatchObject({ appId: result.app.id, status: "queued" });
  expect(result.warnings).toEqual(["A bundling note"]);

  // The builder receives the template's sources without its tests.
  const bundle = builderRequests.find(({ phase }) => phase === "bundle");

  const files = z
    .object({ files: z.record(z.string(), z.string()) })
    .parse(JSON.parse(bundle?.body ?? "{}")).files;

  expect(Object.keys(files)).toEqual(
    expect.arrayContaining(["wrangler.jsonc", "package.json", "src/app.ts", "template.md"]),
  );
  // Tests stay out, in test directories and beside the code (src/*.test.ts).
  expect(
    Object.keys(files).filter((path) => path.startsWith("tests/") || path.includes(".test.")),
  ).toEqual([]);

  const document = builderRequests.find(({ phase }) => phase === "document");
  const documentInput = documentRequest.parse(JSON.parse(document?.body ?? "{}"));

  expect(documentInput).toMatchObject({
    worker,
    map,
    entry: "src/app.ts",
    entrypoints: ["default"],
  });

  // The published artifact carries the build's modules and documentation.
  const artifact = await environment.database.db.query.artifacts.findFirst({
    where: (artifacts, { eq }) => eq(artifacts.id, result.deployment.artifactId),
  });

  const metadata = contract.workerMetadata.parse(artifact?.metadata);

  expect(metadata.service_documentation).toEqual(documentation);
  expect(metadata.bindings).toEqual([{ type: "d1", name: "DB", database_name: "accounts" }]);
  expect(metadata.debug?.source_maps).toEqual({ "worker.js": mapName });
  expect(
    z
      .array(contract.storedModule)
      .parse(artifact?.modules)
      .map(({ name, type }) => [name, type]),
  ).toEqual(
    expect.arrayContaining([
      ["worker.js", "esm"],
      [mapName, "sourcemap"],
    ]),
  );

  // An install never replaces an app: a taken name ends it before the build.
  const requests = builderRequests.length;
  const taken = await install(runtime, "gmail", { name: "mail-reader" });

  expect(taken.status).toBe(409);
  expect(await taken.text()).toContain("An app named mail-reader already exists");
  expect(builderRequests).toHaveLength(requests);

  const renamed = contract.templateInstall.parse(
    await (await install(runtime, "gmail", { name: "mail-reader-2" })).json(),
  );

  expect(renamed.app.id).not.toBe(result.app.id);
  expect(renamed.app.slug).toBe("mail-reader-2");
});

it("reports build errors and missing templates", async () => {
  const runtime = await runtimeWith(builder);

  bundleResponse = () => Response.json({ message: "Could not resolve left-pad" }, { status: 422 });

  const failed = await install(runtime, "github", { name: "repository-reader" });

  expect(failed.status).toBe(400);
  expect(await failed.text()).toContain("Could not resolve left-pad");

  bundleResponse = () => new Response("Internal error", { status: 500 });

  const unavailable = await install(runtime, "github", { name: "repository-reader" });

  expect(unavailable.status).toBe(503);

  const missing = await install(runtime, "missing");

  expect(missing.status).toBe(404);
  expect(builderRequests).toHaveLength(2);

  // Failed builds create no app, so the name stays free.
  const apps = await environment.database.db.query.apps.findMany({
    where: (apps, { eq }) => eq(apps.slug, "repository-reader"),
  });

  expect(apps).toEqual([]);

  const reserved = await install(runtime, "github", { name: "auth" });

  expect(reserved.status).toBe(400);
  expect(builderRequests).toHaveLength(2);
});

it("ends a build that exceeds the deadline", async () => {
  const stalled = createAppBuilder(
    {
      bundle: () => new Promise<Response>(() => {}),
      document: () => new Promise<Response>(() => {}),
    },
    50,
  );

  const runtime = await runtimeWith(stalled);
  const response = await install(runtime, "onedrive", { name: "file-reader" });

  expect(response.status).toBe(503);
});

it("keeps templates on agent setup when no builder is configured", async () => {
  const runtime = await runtimeWith();

  const template = await createApi(runtime)(
    new Request("http://localhost/api/v1/catalog/templates/gmail"),
  );

  expect(contract.appTemplate.parse(await template.json()).installable).toBe(false);

  const response = await install(runtime, "gmail");

  expect(response.status).toBe(400);
  expect(await response.text()).toContain("does not build templates");
});
