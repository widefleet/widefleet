import * as contract from "@platform/contracts";
import type { ciBuildRequest, ciBuildResult } from "@platform/contracts/builds";
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createApi } from "../src/lib/server/api.ts";
import { hashAsset } from "../src/lib/server/asset-hash.ts";
import { executeBuild, type AppCi } from "../src/lib/server/builds.ts";
import { createRuntime, type Runtime } from "../src/lib/server/runtime-services.ts";
import { appBuilds, apps, artifacts, deployments } from "../src/lib/server/schema.ts";
import type { SourceBackend } from "../src/lib/server/source-backend.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createUploadService } from "../src/lib/server/uploads.ts";
import { createTestEnvironment } from "./environment.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let runtime: Runtime;

let storage: ReturnType<typeof createStorage>;

const commit = "c".repeat(40);

const encoder = new TextEncoder();

const heads = new Map<string, string>();

const source = {
  repository: vi.fn(async (id: string) => ({ url: `https://git.example.test/${id}.git` })),
  create: vi.fn(async (id: string) => ({ url: `https://git.example.test/${id}.git` })),
  head: vi.fn(async (id: string) => heads.get(id) ?? null),
  hasCommit: vi.fn(async (id: string, candidate: string) => heads.get(id) === candidate),
  credential: vi.fn(async (id: string) => ({
    url: `https://git.example.test/${id}.git`,
    username: "x",
    password: "read-token",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  })),
  remove: vi.fn(async () => {}),
} satisfies SourceBackend;

const started: string[] = [];

// The output of `widefleet build --output`: one module and one asset.
const worker = encoder.encode('export default { fetch: () => new Response("Built") };\n');

const page = encoder.encode("<h1>Built on the server</h1>\n");

const pageHash = hashAsset("/index.html", page);

const output = {
  format: 1,
  metadata: {
    main_module: "worker.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    bindings: [],
    web: true,
    entrypoints: ["default"],
    crons: [],
    queue_consumers: [],
    assets: { binding: "ASSETS" },
  },
  documentation: { format: 3, entrypoints: [], types: [] },
  modules: [{ name: "worker.js", type: "esm", path: "modules/worker.js" }],
  assets: {
    manifest: { "/index.html": { hash: pageHash, size: page.byteLength } },
    files: { [pageHash]: `assets/${pageHash}` },
  },
};

const files = new Map([
  ["modules/worker.js", worker],
  [`assets/${pageHash}`, page],
]);

const ciRequests: z.infer<typeof ciBuildRequest>[] = [];

const released: string[] = [];

const ci = (result: () => z.infer<typeof ciBuildResult>): AppCi => ({
  build: async (request) => {
    ciRequests.push(request);

    return result();
  },
  file: async (_id, path) => {
    const bytes = files.get(path);

    if (!bytes) throw new Error(`No file ${path}`);

    return bytes;
  },
  release: async (id) => {
    released.push(id);
  },
});

const succeeded = ci(() => ({
  status: "succeeded",
  output: JSON.stringify(output),
  log: "$ widefleet build --output /build/output\nBuild written\n",
}));

const run = (id: string, appCi: AppCi) =>
  executeBuild(id, {
    withDatabase: (operation) => operation(environment.database.db),
    source,
    ci: appCi,
    uploads: (database) =>
      createUploadService(database, storage, environment.configuration, undefined, source),
  });

const api = (path: string, init?: RequestInit) =>
  createApi(runtime)(new Request(`http://localhost/api/v1${path}`, init));

const createApp = async (slug: string) => {
  const response = await api("/apps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, displayName: slug }),
  });

  expect(response.status).toBe(200);

  return contract.app.parse(await response.json());
};

const startBuild = async (appId: string, body: z.input<typeof contract.appBuildInput> = {}) =>
  api(`/apps/${appId}/builds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  environment = await createTestEnvironment();
  storage = createStorage(environment.configuration, memoryStorage());
  runtime = await createRuntime({
    configuration: environment.configuration,
    database: environment.database,
    settings: environment.settings,
    storage,
    reporting: environment.reporting,
    encryption: environment.encryption,
    source,
    startBuild: async (id) => {
      started.push(id);
    },
  })();
  vi.spyOn(runtime.identity, "authenticate").mockResolvedValue(
    Result.ok({
      ...environment.owner,
      role: "owner",
      admin: true,
      creator: true,
      application: environment.application,
    }),
  );
});

beforeEach(async () => {
  await environment.database.db.delete(apps);
  heads.clear();
  started.length = 0;
  ciRequests.length = 0;
  released.length = 0;
});

afterAll(async () => environment?.close());

it("builds the branch's latest commit and publishes it as the CLI would", async () => {
  const app = await createApp("server-built");
  heads.set(app.id, commit);

  const response = await startBuild(app.id);

  expect(response.status).toBe(200);
  const build = contract.appBuild.parse(await response.json());

  expect(build).toMatchObject({
    appId: app.id,
    status: "queued",
    source: { commit, branch: "main", directory: "." },
    deploymentId: null,
  });
  expect(started).toEqual([build.id]);

  await run(build.id, succeeded);

  // The CI receives a read credential for the app's repository.
  expect(ciRequests).toHaveLength(1);
  expect(ciRequests[0]).toMatchObject({ id: build.id, commit, directory: "." });
  expect(ciRequests[0]?.repository.password).toBe("read-token");
  expect(released).toEqual([build.id]);

  const details = contract.appBuildDetails.parse(
    await (await api(`/apps/${app.id}/builds/${build.id}`)).json(),
  );

  expect(details).toMatchObject({ status: "succeeded", message: null });
  expect(details.log).toContain("Build written");
  expect(details.finishedAt).not.toBeNull();

  // The deployment records the built commit as its source, as `widefleet deploy` does.
  const [deployment] = await environment.database.db
    .select({ id: deployments.id, requestId: deployments.requestId, metadata: artifacts.metadata })
    .from(deployments)
    .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
    .where(eq(deployments.appId, app.id));

  expect(deployment).toMatchObject({ id: details.deploymentId, requestId: build.id });
  expect(contract.workerMetadata.parse(deployment?.metadata).source).toEqual({
    commit,
    branch: "main",
    directory: ".",
  });
  expect((await storage.get(`apps/${app.id}/assets/${pageHash}`)).unwrap()).toEqual(page);

  // A repeated run leaves the finished build as it is.
  await run(build.id, succeeded);
  expect(ciRequests).toHaveLength(1);

  const listed = contract.appBuild
    .array()
    .parse(await (await api(`/apps/${app.id}/builds`)).json());

  expect(listed.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: build.id, status: "succeeded" },
  ]);
});

it("publishes once when a run stops after publishing", async () => {
  const app = await createApp("published-once");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  await run(build.id, succeeded);
  // The run stopped before it could record its outcome.
  await environment.database.db
    .update(appBuilds)
    .set({ status: "running", deploymentId: null, finishedAt: null })
    .where(eq(appBuilds.id, build.id));

  await run(build.id, succeeded);

  const published = await environment.database.db
    .select({ id: deployments.id })
    .from(deployments)
    .where(eq(deployments.appId, app.id));

  expect(published).toHaveLength(1);

  const [record] = await environment.database.db
    .select()
    .from(appBuilds)
    .where(eq(appBuilds.id, build.id));

  expect(record).toMatchObject({ status: "succeeded", deploymentId: published[0]?.id });
});

it("records a failed build with the end of its log", async () => {
  const app = await createApp("failing-build");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  await run(
    build.id,
    ci(() => ({
      status: "failed",
      message: "pnpm install failed with exit code 1",
      log: "$ pnpm install --frozen-lockfile\nERR_PNPM_OUTDATED_LOCKFILE\n",
    })),
  );

  const details = contract.appBuildDetails.parse(
    await (await api(`/apps/${app.id}/builds/${build.id}`)).json(),
  );

  expect(details).toMatchObject({
    status: "failed",
    message: "pnpm install failed with exit code 1",
    deploymentId: null,
  });
  expect(details.log).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
  expect(released).toEqual([build.id]);
});

it("rejects a build output the platform cannot deploy without publishing", async () => {
  const app = await createApp("invalid-output");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  await run(
    build.id,
    ci(() => ({
      status: "succeeded",
      output: JSON.stringify({
        ...output,
        metadata: { ...output.metadata, compatibility_flags: ["experimental"] },
      }),
      log: "",
    })),
  );

  const [record] = await environment.database.db
    .select()
    .from(appBuilds)
    .where(eq(appBuilds.id, build.id));

  expect(record?.status).toBe("failed");
  expect(record?.message).toMatch(/not deployable/);
  expect(
    await environment.database.db.select().from(deployments).where(eq(deployments.appId, app.id)),
  ).toEqual([]);
});

it("builds only commits of the app's repository", async () => {
  const app = await createApp("unsaved-source");

  const empty = await startBuild(app.id);

  expect(empty.status).toBe(409);
  expect(await empty.text()).toMatch(/has no commits/);

  heads.set(app.id, commit);

  const foreign = await startBuild(app.id, { commit: "d".repeat(40) });

  expect(foreign.status).toBe(400);
  expect(await foreign.text()).toMatch(/not stored in this app's repository/);
  expect(started).toEqual([]);
});
