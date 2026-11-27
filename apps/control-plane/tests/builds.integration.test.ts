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
import { createTestEnvironment } from "./environment.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let runtime: Runtime;

let storage: ReturnType<typeof createStorage>;

const commit = "c".repeat(40);

const heads = new Map<string, string>();

const source = {
  repository: vi.fn(async (id: string) => ({ url: `https://git.example.test/${id}.git` })),
  create: vi.fn(async (id: string) => ({ url: `https://git.example.test/${id}.git` })),
  head: vi.fn(async (id: string) => heads.get(id) ?? null),
  hasCommit: vi.fn(async (id: string, candidate: string) => heads.get(id) === candidate),
  credential: vi.fn(async (id: string) => ({
    url: `https://git.example.test/${id}.git`,
    username: "x",
    password: "token",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  })),
  remove: vi.fn(async () => {}),
} satisfies SourceBackend;

const started: string[] = [];

const page = new TextEncoder().encode("<h1>Built on the server</h1>\n");

const pageHash = hashAsset("/index.html", page);

const ciRequests: z.infer<typeof ciBuildRequest>[] = [];

const released: string[] = [];

/** Requests as the CI sends them for the build: with its token and organization. */
const asBuild = (request: z.infer<typeof ciBuildRequest>, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${request.platform.token}`);
  headers.set("x-widefleet-organization", request.platform.organizationId);

  return api(path, { ...init, headers });
};

/** The uploads of `widefleet deploy`, and the idempotency key the CI sets. */
const deploy = async (request: z.infer<typeof ciBuildRequest>) => {
  const session = contract.uploadSession.parse(
    await (
      await asBuild(request, `/apps/${request.appId}/assets-upload-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest: { "/index.html": { hash: pageHash, size: page.byteLength } },
        }),
      })
    ).json(),
  );

  for (const hash of session.missing)
    expect(
      (
        await asBuild(request, `/apps/${request.appId}/assets/${session.id}/${hash}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: page,
        })
      ).status,
    ).toBe(200);

  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      assets: { upload_session: session.id },
      bindings: [],
      source: request.source,
    }),
  );
  form.set(
    contract.serviceDocumentationPart,
    new Blob([JSON.stringify({ format: 3, entrypoints: [], types: [] })], {
      type: "application/json",
    }),
    "documentation.json",
  );
  form.set(
    "worker.js",
    new Blob(['export default { fetch: () => new Response("Built") };\n'], {
      type: "application/javascript+module",
    }),
    "worker.js",
  );

  return asBuild(request, `/apps/${request.appId}/worker`, {
    method: "PUT",
    headers: { "idempotency-key": request.id },
    body: form,
  });
};

const ci = (
  result: (request: z.infer<typeof ciBuildRequest>) => Promise<z.infer<typeof ciBuildResult>>,
): AppCi => ({
  build: async (request) => {
    ciRequests.push(request);

    return result(request);
  },
  release: async (id) => {
    released.push(id);
  },
});

const succeeded = ci(async (request) => {
  expect((await deploy(request)).status).toBe(200);

  return { status: "succeeded", log: "$ widefleet deploy\nDeployment succeeded\n" };
});

const run = (id: string, appCi: AppCi) =>
  executeBuild(id, {
    withDatabase: (operation) => operation(environment.database.db),
    source,
    ci: appCi,
    platformUrl: environment.configuration.PLATFORM_URL,
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
  // Builds authenticate with their token; everything else is the owner.
  const authenticate = runtime.identity.authenticate;

  vi.spyOn(runtime.identity, "authenticate").mockImplementation(async (request, scope) =>
    request.headers.get("authorization")?.startsWith("Bearer wfb_")
      ? authenticate(request, scope)
      : Result.ok({
          ...environment.owner,
          role: "owner" as const,
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

it("deploys the branch's latest commit with widefleet deploy as the person who started it", async () => {
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

  // The CI receives the app's repository and the control plane, with the build's token.
  expect(ciRequests).toHaveLength(1);
  expect(ciRequests[0]).toMatchObject({
    id: build.id,
    appId: app.id,
    platform: {
      url: environment.configuration.PLATFORM_URL,
      organizationId: environment.application.organizationId,
    },
    source: { commit, branch: "main", directory: "." },
  });
  expect(ciRequests[0]?.repository).toEqual({ url: `https://git.example.test/${app.id}.git` });
  expect(released).toEqual([build.id]);

  const details = contract.appBuildDetails.parse(
    await (await api(`/apps/${app.id}/builds/${build.id}`)).json(),
  );

  expect(details).toMatchObject({ status: "succeeded", message: null });
  expect(details.log).toContain("Deployment succeeded");
  expect(details.finishedAt).not.toBeNull();

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

  // The token ends with the build.
  const ended = await asBuild(ciRequests[0]!, `/apps/${app.id}/assets-upload-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: {} }),
  });

  expect(ended.status).toBe(401);

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

it("publishes once when a build runs again after publishing", async () => {
  const app = await createApp("published-once");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  // The first run published, then stopped before it recorded its outcome.
  await run(
    build.id,
    ci(async (request) => {
      expect((await deploy(request)).status).toBe(200);

      throw new Error("The CI was interrupted");
    }),
  ).catch(() => {});

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
    ci(async () => ({
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

it("fails a build that finished without publishing", async () => {
  const app = await createApp("unpublished");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  await run(
    build.id,
    ci(async () => ({ status: "succeeded", log: "" })),
  );

  const [record] = await environment.database.db
    .select()
    .from(appBuilds)
    .where(eq(appBuilds.id, build.id));

  expect(record).toMatchObject({ status: "failed", deploymentId: null, tokenHash: null });
  expect(record?.message).toMatch(/did not publish/);
});

it("does not let builds change network access", async () => {
  const app = await createApp("limited-build");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  await run(
    build.id,
    ci(async (request) => {
      const network = await asBuild(request, `/apps/${app.id}/network`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allow: ["https://example.com"] }),
      });

      expect([401, 403]).toContain(network.status);

      return { status: "failed", message: "Stopped", log: "" };
    }),
  );
});

it("builds only apps whose branch has commits", async () => {
  const app = await createApp("unsaved-source");

  const empty = await startBuild(app.id);

  expect(empty.status).toBe(409);
  expect(await empty.text()).toMatch(/has no commits/);
  expect(started).toEqual([]);
});
