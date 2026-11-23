import { readFile } from "node:fs/promises";
import * as contract from "@platform/contracts";
import { bundleResult, documentRequest } from "@platform/contracts/builds";
import { Result } from "better-result";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApi } from "../src/lib/server/api.ts";
import { createAppBuilder } from "../src/lib/server/app-builder.ts";
import { createRuntime, type Runtime } from "../src/lib/server/runtime-services.ts";
import { templateNetworkChanged } from "../src/lib/server/template-installs.ts";
import { InvalidOperation } from "../src/lib/server/errors.ts";
import { AuthenticationFailed } from "../src/lib/server/identity.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { hashAsset } from "../src/lib/server/asset-hash.ts";
import { createTestEnvironment } from "./environment.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";
import { templateCommit, templateRepository } from "./template-repository.fixture.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

const originalFetch = globalThis.fetch;

const worker = 'export default { fetch: () => new Response("Hello") };\n';

const map = JSON.stringify({ version: 3, sources: ["src/app.ts"], names: [], mappings: "" });

const mapName = `map-${"a".repeat(64)}.map`;

const documentation = {
  format: 3,
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
  vi.spyOn(runtime.identity, "authenticateUser").mockResolvedValue(
    Result.ok({ userId: environment.owner.id, identityOrganizationId: null, recovery: false }),
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

  // The app records the template it was installed from, and the catalog
  // leads to it instead of offering another install.
  const record = await environment.database.db.query.apps.findFirst({
    where: (apps, { eq }) => eq(apps.id, result.app.id),
  });

  expect(record).toMatchObject({ templateId: "gmail", templateCommit });

  // The app starts with the template's description.
  const guide = await readFile(
    new URL("../../../templates/gmail/template.md", import.meta.url),
    "utf8",
  );

  expect(result.app.description).toBe(/^description: (.*)$/mu.exec(guide)?.[1]);

  const api = createApi(runtime);

  const installedTemplate = contract.appTemplate.parse(
    await (await api(new Request("http://localhost/api/v1/catalog/templates/gmail"))).json(),
  );

  expect(installedTemplate.installedAppId).toBe(result.app.id);

  const catalog = contract.appTemplateCatalog.parse(
    await (await api(new Request("http://localhost/api/v1/catalog/templates"))).json(),
  );

  expect(catalog.templates.find(({ id }) => id === "gmail")?.installedAppId).toBe(result.app.id);

  // Members who cannot manage the app are not led to it.
  const principal = (
    await runtime.identity.authenticate(new Request("http://localhost"), "platform:read")
  ).unwrap();

  const member = {
    ...principal,
    id: crypto.randomUUID(),
    application: { ...principal.application, admin: false },
  };

  expect((await runtime.apps.templateInstalls(member)).unwrap().has("gmail")).toBe(false);

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
  // Static assets are uploaded by the control plane, not bundled.
  expect(Object.keys(files).filter((path) => path.startsWith("public/"))).toEqual([]);

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

  expect(
    JSON.parse(
      new TextDecoder().decode(
        (
          await runtime.storage.get(
            `apps/${result.app.id}/service-documentation/${result.deployment.artifactId}.json`,
          )
        ).unwrap(),
      ),
    ),
  ).toEqual(contract.serviceDocumentation.parse(documentation));
  expect(metadata.assets.binding).toBe("ASSETS");

  // The template's static assets are part of the deployment, as with the CLI.
  const favicon = new Uint8Array(
    await readFile(new URL("../../../templates/gmail/public/favicon.svg", import.meta.url)),
  );

  const icon = { hash: hashAsset("/favicon.svg", favicon), size: favicon.byteLength };

  expect(contract.assetManifest.parse(artifact?.manifest)).toEqual({ "/favicon.svg": icon });
  const stored = await runtime.storage.get(`apps/${result.app.id}/assets/${icon.hash}`);
  expect(stored.isOk() && new Uint8Array(stored.value)).toEqual(favicon);
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

  // An app that never received a deployment, such as one left by an install
  // that failed to publish, takes the install.
  const draft = await createApi(runtime)(
    new Request("http://localhost/api/v1/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "mail-draft", displayName: "mail-draft" }),
    }),
  );

  expect(draft.status).toBe(200);
  const empty = contract.app.parse(await draft.json());

  const resumed = contract.templateInstall.parse(
    await (await install(runtime, "gmail", { name: "mail-draft" })).json(),
  );

  expect(resumed.app.id).toBe(empty.id);
  expect(resumed.deployment).toMatchObject({ appId: empty.id, status: "queued" });
  expect(resumed.app.description).toBe(result.app.description);

  // A description someone already saved stays.
  const named = contract.app.parse(
    await (
      await createApi(runtime)(
        new Request("http://localhost/api/v1/apps", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: "mail-described", displayName: "mail-described" }),
        }),
      )
    ).json(),
  );

  await createApi(runtime)(
    new Request(`http://localhost/api/v1/apps/${named.id}/description`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Reads the team inbox." }),
    }),
  );

  const described = contract.templateInstall.parse(
    await (await install(runtime, "gmail", { name: "mail-described" })).json(),
  );

  expect(described.app.description).toBe("Reads the team inbox.");
});

// A build of a template that declares one backend origin.
const declaredBundle = () =>
  Response.json(
    bundleResult.parse({
      worker,
      map,
      entry: "src/app.ts",
      metadata: {
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        compatibility_flags: [],
        bindings: [],
        debug: { build_id: "c".repeat(64), source_maps: { "worker.js": mapName } },
        web: true,
        entrypoints: ["default"],
        crons: [],
        queue_consumers: [],
        network: { backend: ["https://api.github.com"], browser: [] },
      },
      warnings: [],
    }),
  );

const github = { backend: ["https://api.github.com"], browser: [] };

it("grants consented origins on the template page and requests them through the API", async () => {
  const runtime = await runtimeWith(builder);
  const fixed = bundleResponse;
  const authenticate = vi.mocked(runtime.identity.authenticate);
  const owner = await authenticate(new Request("http://localhost"), "platform:write");

  // A CLI token without the network:manage scope.
  authenticate.mockImplementation(async (_request, scope) =>
    scope === "network:manage"
      ? Result.err(
          new AuthenticationFailed({
            code: "FORBIDDEN",
            message: "The access token lacks the required scope",
          }),
        )
      : owner,
  );

  bundleResponse = declaredBundle;

  try {
    const response = await install(runtime, "github", { name: "github-requested" });

    expect(response.status, await response.clone().text()).toBe(200);
    const requested = contract.templateInstall.parse(await response.json());

    expect(requested.requestedNetwork).toEqual(github);

    const principal = (
      await runtime.identity.authenticate(new Request("http://localhost"), "platform:write")
    ).unwrap();

    const state = (await runtime.network.read(principal, requested.app.id)).unwrap();

    expect(state.policy.backend).toEqual([]);
    expect(state.requested).toEqual(github);

    // The page showed fewer origins than the template now declares.
    const changed = await runtime.templates.install(
      principal,
      { templateId: "github", name: "github-changed", secrets: {} },
      { consentedNetwork: { backend: [], browser: [] } },
    );

    expect(changed.isErr() && changed.error.message).toBe(templateNetworkChanged);
    expect((await runtime.apps.named(principal, "github-changed")).unwrap()).toBeNull();

    const granted = (
      await runtime.templates.install(
        principal,
        { templateId: "github", name: "github-granted", secrets: {} },
        { consentedNetwork: github },
      )
    ).unwrap();

    expect(granted.requestedNetwork).toBeUndefined();

    // A grant that fails after publishing leaves the install done and the
    // origins requested.
    const change = vi
      .spyOn(runtime.network, "change")
      .mockResolvedValueOnce(
        Result.err(
          new InvalidOperation({ code: "CONFLICT", message: "Synthetic activation conflict" }),
        ),
      );

    const pending = (
      await runtime.templates.install(
        principal,
        { templateId: "github", name: "github-pending", secrets: {} },
        { consentedNetwork: github },
      )
    ).unwrap();

    change.mockRestore();
    expect(pending.requestedNetwork).toEqual(github);
    expect(pending.warnings).toContain(
      "Network access could not be allowed yet: Synthetic activation conflict",
    );

    const allowed = (await runtime.network.read(principal, granted.app.id)).unwrap();

    expect(allowed.policy.backend).toEqual(github.backend);
    expect(allowed.requested).toEqual({ backend: [], browser: [] });

    // With network:manage, an API install grants what the template declares.
    authenticate.mockResolvedValue(owner);

    const managed = await install(runtime, "github", { name: "github-managed" });

    expect(managed.status, await managed.clone().text()).toBe(200);
    const installed = contract.templateInstall.parse(await managed.json());

    expect(installed.requestedNetwork).toBeUndefined();
    expect(
      (await runtime.network.read(principal, installed.app.id)).unwrap().policy.backend,
    ).toEqual(github.backend);
  } finally {
    bundleResponse = fixed;
  }
});

it("compares allowed origins with the latest deployment's declaration", async () => {
  const runtime = await runtimeWith(builder);

  const principal = (
    await runtime.identity.authenticate(new Request("http://localhost"), "platform:write")
  ).unwrap();

  const app = (
    await runtime.apps.create(
      principal,
      contract.createAppInput.parse({ slug: "declared", displayName: "declared" }),
    )
  ).unwrap();

  (
    await runtime.network.change(principal, app.id, {
      target: "backend",
      action: "allow",
      origins: ["https://first.example.test"],
    })
  ).unwrap();

  const session = (await runtime.uploads.start(principal, app.id, {})).unwrap();

  (
    await runtime.uploads.publish(
      principal,
      app.id,
      contract.workerMetadata.parse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        bindings: [],
        assets: { upload_session: session.id, binding: "ASSETS" },
        network: { backend: ["https://second.example.test"] },
      }),
      null,
      [{ name: "worker.js", type: "esm", bytes: new TextEncoder().encode(worker) }],
      crypto.randomUUID(),
    )
  ).unwrap();

  expect((await runtime.network.read(principal, app.id)).unwrap()).toMatchObject({
    policy: { backend: ["https://first.example.test"], browser: [] },
    requested: { backend: ["https://second.example.test"], browser: [] },
    undeclared: { backend: ["https://first.example.test"], browser: [] },
  });
});

it("does not install over an app deployed while the template builds", async () => {
  let duringBuild = async () => {};

  const racing = createAppBuilder({
    bundle: async () => {
      await duringBuild();

      return bundleResponse();
    },
    document: async () => Response.json({ documentation, warnings: [] }),
  });

  const runtime = await runtimeWith(racing);

  const created = await createApi(runtime)(
    new Request("http://localhost/api/v1/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "mail-race", displayName: "mail-race" }),
    }),
  );

  const app = contract.app.parse(await created.json());

  const principal = (
    await runtime.identity.authenticate(new Request("http://localhost"), "platform:write")
  ).unwrap();

  // Someone deploys their own code to the empty app during the build.
  duringBuild = async () => {
    const session = (await runtime.uploads.start(principal, app.id, {})).unwrap();

    (
      await runtime.uploads.publish(
        principal,
        app.id,
        contract.workerMetadata.parse({
          main_module: "worker.js",
          compatibility_date: "2026-10-01",
          bindings: [],
          assets: { upload_session: session.id, binding: "ASSETS" },
        }),
        null,
        [{ name: "worker.js", type: "esm", bytes: new TextEncoder().encode(worker) }],
        crypto.randomUUID(),
      )
    ).unwrap();
  };

  const fixed = bundleResponse;

  bundleResponse = declaredBundle;

  try {
    // Installing from the page, whose consent must not reach the other app.
    const raced = await runtime.templates.install(
      principal,
      { templateId: "gmail", name: "mail-race", secrets: {} },
      { consentedNetwork: github },
    );

    expect(raced.isErr() && raced.error.message).toContain("An app named mail-race already exists");
  } finally {
    bundleResponse = fixed;
  }

  expect((await runtime.network.read(principal, app.id)).unwrap().policy.backend).toEqual([]);

  const deployments = await environment.database.db.query.deployments.findMany({
    where: (deployments, { eq }) => eq(deployments.appId, app.id),
  });

  // Only the concurrent deployment exists.
  expect(deployments).toHaveLength(1);

  // The other deployment's app is not marked as installed from the template or described by it.
  const record = await environment.database.db.query.apps.findFirst({
    where: (apps, { eq }) => eq(apps.id, app.id),
  });

  expect(record).toMatchObject({ templateId: null, templateCommit: null, description: null });
});

it("saves the secrets a template requires before its first deployment", async () => {
  const runtime = await runtimeWith(builder);
  const fixed = bundleResponse;
  const required = ["SYNTHETIC_CLIENT_ID", "SYNTHETIC_CLIENT_SECRET"];

  const principal = (
    await runtime.identity.authenticate(new Request("http://localhost"), "platform:write")
  ).unwrap();

  // The template's Wrangler file requires two secrets, at the pinned commit
  // and on its page.
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.pathname.endsWith("/templates/linear/wrangler.jsonc"))
      return Response.json({
        name: "linear",
        main: "src/app.ts",
        compatibility_date: "2026-10-01",
        secrets: { required },
      });

    return (await templateRepository(url)) ?? originalFetch(input, init);
  });

  bundleResponse = () =>
    Response.json(
      bundleResult.parse({
        worker,
        map,
        entry: "src/app.ts",
        metadata: {
          main_module: "worker.js",
          compatibility_date: "2026-10-01",
          compatibility_flags: [],
          bindings: [],
          debug: { build_id: "d".repeat(64), source_maps: { "worker.js": mapName } },
          web: true,
          entrypoints: ["default"],
          crons: [],
          queue_consumers: [],
          required_secrets: required,
        },
        warnings: [],
      }),
    );

  try {
    const page = await createApi(runtime)(
      new Request("http://localhost/api/v1/catalog/templates/linear"),
    );

    expect(contract.appTemplate.parse(await page.json()).requiredSecrets).toEqual(required);

    // Every required value is needed, and only those, before anything is built.
    const missing = await install(runtime, "linear", {
      name: "issues",
      secrets: { SYNTHETIC_CLIENT_ID: "client" },
    });

    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain(
      "Provide values for the template's required secrets: SYNTHETIC_CLIENT_SECRET",
    );

    const extra = await install(runtime, "linear", {
      name: "issues",
      secrets: { SYNTHETIC_CLIENT_ID: "client", SYNTHETIC_CLIENT_SECRET: "secret", OTHER: "x" },
    });

    expect(extra.status).toBe(400);
    expect(await extra.text()).toContain("The template does not require OTHER");
    expect(builderRequests).toEqual([]);
    expect((await runtime.apps.named(principal, "issues")).unwrap()).toBeNull();

    // Only members who may create apps install templates, and nothing is saved otherwise.
    vi.mocked(runtime.identity.authenticate).mockResolvedValueOnce(
      Result.ok({ ...principal, creator: false }),
    );

    const forbidden = await install(runtime, "linear", {
      name: "issues",
      secrets: { SYNTHETIC_CLIENT_ID: "client", SYNTHETIC_CLIENT_SECRET: "secret" },
    });

    expect(forbidden.status).toBe(403);
    expect((await runtime.apps.named(principal, "issues")).unwrap()).toBeNull();

    const response = await install(runtime, "linear", {
      name: "issues",
      secrets: { SYNTHETIC_CLIENT_ID: "client", SYNTHETIC_CLIENT_SECRET: "secret" },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const installed = contract.templateInstall.parse(await response.json());

    expect(installed.deployment.status).toBe("queued");

    // The values are app secrets, and the deployed version records its list.
    const secrets = (await runtime.appSecrets.read(principal, installed.app.id)).unwrap();

    expect(secrets).toMatchObject({ names: required, required });

    const artifact = await environment.database.db.query.artifacts.findFirst({
      where: (artifacts, { eq }) => eq(artifacts.id, installed.deployment.artifactId),
    });

    expect(contract.workerMetadata.parse(artifact?.metadata).required_secrets).toEqual(required);

    // Removing a required secret is allowed; the page then lists it as missing.
    const removed = (
      await runtime.appSecrets.set(principal, installed.app.id, "SYNTHETIC_CLIENT_SECRET", null)
    ).unwrap();

    expect(removed).toMatchObject({ names: ["SYNTHETIC_CLIENT_ID"], required });
  } finally {
    bundleResponse = fixed;
  }
});

it("keeps offering a template whose deployment was rejected", async () => {
  const runtime = await runtimeWith(builder);

  // As when Cloudflare rejects a hosted deployment after the app was prepared.
  vi.spyOn(runtime.uploads, "publish").mockResolvedValue(
    Result.err(new InvalidOperation({ code: "BAD_REQUEST", message: "Deployment rejected" })),
  );

  const response = await install(runtime, "gmail", { name: "mail-rejected" });

  expect(response.status).toBe(400);

  const record = await environment.database.db.query.apps.findFirst({
    where: (apps, { eq }) => eq(apps.slug, "mail-rejected"),
  });

  expect(record).toMatchObject({ templateId: null, templateCommit: null });
});

it("reports build errors and missing templates", async () => {
  const runtime = await runtimeWith(builder);

  bundleResponse = () => Response.json({ message: "Could not resolve left-pad" }, { status: 422 });

  const failed = await install(runtime, "github", { name: "repository-reader" });

  expect(failed.status).toBe(400);
  expect(await failed.text()).toContain("Could not resolve left-pad");

  // A build the upload would reject fails before the app exists, here a
  // required secret named like the default assets binding.
  bundleResponse = () =>
    Response.json(
      bundleResult.parse({
        worker,
        map,
        entry: "src/app.ts",
        metadata: {
          main_module: "worker.js",
          compatibility_date: "2026-10-01",
          compatibility_flags: [],
          bindings: [],
          debug: { build_id: "f".repeat(64), source_maps: { "worker.js": mapName } },
          web: true,
          entrypoints: ["default"],
          crons: [],
          queue_consumers: [],
          required_secrets: ["ASSETS"],
        },
        warnings: [],
      }),
    );

  const undeployable = await install(runtime, "github", { name: "repository-reader" });

  expect(undeployable.status).toBe(400);
  expect(await undeployable.text()).toContain("The template's build is not deployable");

  bundleResponse = () => new Response("Internal error", { status: 500 });

  const unavailable = await install(runtime, "github", { name: "repository-reader" });

  expect(unavailable.status).toBe(503);

  const missing = await install(runtime, "missing");

  expect(missing.status).toBe(404);
  expect(builderRequests).toHaveLength(3);

  // A template whose document cannot be read fails before anything is built or created.
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    return url.pathname.endsWith("/templates/github/template.md")
      ? new Response("No frontmatter")
      : ((await templateRepository(url)) ?? originalFetch(input, init));
  });

  const unreadable = await install(runtime, "github", { name: "repository-reader" });

  expect(unreadable.status).toBe(400);
  expect(await unreadable.text()).toContain("no readable description");
  expect(builderRequests).toHaveLength(3);

  // Failed builds create no app, so the name stays free.
  const apps = await environment.database.db.query.apps.findMany({
    where: (apps, { eq }) => eq(apps.slug, "repository-reader"),
  });

  expect(apps).toEqual([]);

  const reserved = await install(runtime, "github", { name: "auth" });

  expect(reserved.status).toBe(400);
  expect(builderRequests).toHaveLength(3);
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

it("serves a template's favicon from its static assets for the catalog", async () => {
  const runtime = await runtimeWith(builder);
  const api = createApi(runtime);

  const response = await api(new Request("http://localhost/api/v1/catalog/templates/github/icon"));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array(
      await readFile(new URL("../../../templates/github/public/favicon.svg", import.meta.url)),
    ),
  );

  // Unknown templates have no icon, and template IDs are validated.
  expect(
    (await api(new Request("http://localhost/api/v1/catalog/templates/missing/icon"))).status,
  ).toBe(404);
  expect(
    (await api(new Request("http://localhost/api/v1/catalog/templates/Bad%2Fid/icon"))).status,
  ).toBe(400);
});
