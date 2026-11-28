import * as contract from "@platform/contracts";
import { ciBuildResult, ciBuildTimeLimit, type ciBuildRequest } from "@platform/contracts/builds";
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createApi } from "../src/lib/server/api.ts";
import { hashAsset } from "../src/lib/server/asset-hash.ts";
import { executeBuild, failBuild, type AppCi } from "../src/lib/server/builds.ts";
import { InvalidOperation } from "../src/lib/server/errors.ts";
import type { BuildPolicy } from "../src/lib/server/runtime-extension.ts";
import { AuthenticationFailed } from "../src/lib/server/identity.ts";
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
  // Apps get a repository when their source is first saved.
  repository: vi.fn(async (id: string) =>
    heads.has(id) ? { url: `https://git.example.test/${id}.git` } : null,
  ),
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

// The installation's build policy: what it admits, and the container time it settles.
const admitted: { id: string; organizationId: string; appId: string }[] = [];

const settled: { id: string; seconds: number | null }[] = [];

let admission = (): number | InvalidOperation => ciBuildTimeLimit;

const policy: BuildPolicy = {
  admit: async (_transaction, build) => {
    admitted.push(build);

    return admission();
  },
  settle: async (_executor, build) => {
    settled.push(build);
  },
};

const ended = new Set<string>();

// Whether the credential that starts builds lacks platform:read.
let writeOnly = false;

const page = new TextEncoder().encode("<h1>Built on the server</h1>\n");

const pageHash = hashAsset("/index.html", page);

const ciRequests: z.infer<typeof ciBuildRequest>[] = [];

const released: string[] = [];

const outcomes = new Map<string, z.infer<typeof ciBuildResult>>();

/** Requests as the CI sends them for the build: with its token and organization. */
const asBuild = (request: z.infer<typeof ciBuildRequest>, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${request.platform.token}`);
  headers.set("x-widefleet-organization", request.platform.organizationId);

  return api(path, { ...init, headers });
};

/** The uploads of `widefleet deploy`, and the idempotency key the CI sets. */
const deploy = async (
  request: z.infer<typeof ciBuildRequest>,
  source: z.infer<typeof contract.sourceRevision> = request.source,
) => {
  // The CI gets a repository credential for each Git request.
  const credential = await asBuild(request, `/apps/${request.appId}/source/write-credential`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  expect(credential.status).toBe(200);
  expect(contract.sourceCredential.parse(await credential.json()).url).toBe(request.repository.url);

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
      source,
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

/** The outcome of a fake CI run; each run uses a minute of container time. */
type Outcome =
  | { status: "succeeded"; log: string }
  | { status: "failed"; message: string; log: string };

const ci = (result: (request: z.infer<typeof ciBuildRequest>) => Promise<Outcome>): AppCi => ({
  build: async (request) => {
    ciRequests.push(request);
    const outcome = ciBuildResult.parse({ ...(await result(request)), seconds: 60 });
    outcomes.set(request.id, outcome);

    return outcome;
  },
  result: async (id) => outcomes.get(id) ?? null,
  // As the CI, a released build keeps its outcome without the log.
  release: async (id) => {
    released.push(id);
    const outcome = outcomes.get(id);

    if (outcome) outcomes.set(id, { ...outcome, log: "" });
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
    encryption: environment.encryption,
    policy,
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
    buildPolicy: policy,
    builds: {
      start: async (id) => {
        started.push(id);
      },
      ended: async (id) => ended.has(id),
    },
  })();
  // Builds authenticate with their token; everything else is the owner.
  const authenticate = runtime.identity.authenticate;

  vi.spyOn(runtime.identity, "authenticate").mockImplementation(async (request, scope, builds) =>
    request.headers.get("authorization")?.startsWith("Bearer wfb_")
      ? authenticate(request, scope, builds)
      : Result.ok({
          ...environment.owner,
          role: "owner" as const,
          admin: true,
          creator: true,
          application: environment.application,
        }),
  );

  const authenticateUser = runtime.identity.authenticateUser;

  vi.spyOn(runtime.identity, "authenticateUser").mockImplementation(async (request, scope) =>
    request.headers.get("authorization")?.startsWith("Bearer wfb_")
      ? authenticateUser(request, scope)
      : writeOnly && scope === "platform:read"
        ? Result.err(
            new AuthenticationFailed({ code: "FORBIDDEN", message: "The token lacks the scope" }),
          )
        : Result.ok({
            userId: environment.owner.id,
            identityOrganizationId: null,
            recovery: false,
          }),
  );
});

beforeEach(async () => {
  await environment.database.db.delete(apps);
  heads.clear();
  started.length = 0;
  ciRequests.length = 0;
  released.length = 0;
  outcomes.clear();
  ended.clear();
  writeOnly = false;
  admitted.length = 0;
  settled.length = 0;
  admission = () => ciBuildTimeLimit;
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

it("concludes a build that published when its repository is gone before the run is repeated", async () => {
  const app = await createApp("published-repository-gone");
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

  heads.delete(app.id);
  await run(build.id, succeeded);

  const [record] = await environment.database.db
    .select()
    .from(appBuilds)
    .where(eq(appBuilds.id, build.id));

  expect(record).toMatchObject({ status: "succeeded" });
  expect(record?.deploymentId).not.toBeNull();
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

  expect(record).toMatchObject({ status: "failed", deploymentId: null });
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

it("confines a build's token to its app", async () => {
  const app = await createApp("confined-build");
  const other = await createApp("other-app");
  heads.set(app.id, commit);
  heads.set(other.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  const statuses: Record<string, number> = {};

  await run(
    build.id,
    ci(async (request) => {
      const status = async (name: string, path: string, init?: RequestInit) => {
        statuses[name] = (await asBuild(request, path, init)).status;
      };

      await status("own", `/apps/${app.id}/network`);
      await status("other", `/apps/${other.id}/network`);
      // Input fields can name an app as the path does.
      await status("override", `/apps/${app.id}/network?appId=${other.id}`);
      // Builds make only the requests of `widefleet deploy`.
      await status("history", `/apps/${app.id}/deployments`);
      await status("target", "/apps/source-target", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: other.id }),
      });
      await status("list", `/apps?appId=${app.id}`);
      await status("build", `/apps/${app.id}/builds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      return { status: "failed", message: "Stopped", log: "" };
    }),
  );

  expect(statuses).toEqual({
    own: 200,
    other: 403,
    override: 403,
    history: 403,
    target: 403,
    list: 403,
    build: 403,
  });
});

it("stops accepting a build's token at its deadline", async () => {
  const app = await createApp("expired-build");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  await run(
    build.id,
    ci(async (request) => {
      expect(request.deadline).toBeGreaterThan(Date.now());

      await environment.database.db
        .update(appBuilds)
        .set({ deadline: new Date(Date.now() - 1000) })
        .where(eq(appBuilds.id, request.id));

      expect((await asBuild(request, `/apps/${app.id}/network`)).status).toBe(401);

      return { status: "failed", message: "Stopped", log: "" };
    }),
  );
});

it("keeps a recorded failure when a run that published is repeated", async () => {
  const app = await createApp("failed-after-publish");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  const failing = ci(async (request) => {
    expect((await deploy(request)).status).toBe(200);

    return {
      status: "failed",
      message: "widefleet deploy failed with exit code 1",
      log: "Failed\n",
    };
  });

  // The first run published and stopped before it recorded the CI's outcome.
  await run(build.id, {
    ...failing,
    release: async () => {
      throw new Error("The CI was unreachable");
    },
  }).catch(() => {});
  await environment.database.db
    .update(appBuilds)
    .set({ status: "running", finishedAt: null })
    .where(eq(appBuilds.id, build.id));

  await run(build.id, failing);

  const [record] = await environment.database.db
    .select()
    .from(appBuilds)
    .where(eq(appBuilds.id, build.id));

  expect(record).toMatchObject({
    status: "failed",
    message: "widefleet deploy failed with exit code 1",
    log: "Failed\n",
  });
  expect(record?.deploymentId).not.toBeNull();
  expect(ciRequests).toHaveLength(1);
});

it("stores logs with NUL characters", async () => {
  const app = await createApp("nul-log");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  await run(
    build.id,
    ci(async () => ({ status: "failed", message: "Stopped\u0000", log: "binary\u0000output\n" })),
  );

  const [record] = await environment.database.db
    .select()
    .from(appBuilds)
    .where(eq(appBuilds.id, build.id));

  expect(record).toMatchObject({ status: "failed", message: "Stopped", log: "binaryoutput\n" });
});

it("retries a run that starts before its build is committed", async () => {
  await expect(run(crypto.randomUUID(), succeeded)).rejects.toThrow(/not recorded/);
  expect(ciRequests).toEqual([]);
});

it("gives a build only the scopes of the credential that started it", async () => {
  const app = await createApp("write-only-build");
  heads.set(app.id, commit);
  writeOnly = true;
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  await run(
    build.id,
    ci(async (request) => {
      expect((await asBuild(request, `/apps/${app.id}/network`)).status).toBe(403);
      expect((await deploy(request)).status).toBe(200);

      return { status: "succeeded", log: "" };
    }),
  );

  expect(
    contract.appBuildDetails.parse(await (await api(`/apps/${app.id}/builds/${build.id}`)).json())
      .status,
  ).toBe("succeeded");
});

it("reports a build whose workflow ended without finishing it as failed", async () => {
  const app = await createApp("stopped-workflow");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  ended.add(build.id);

  const details = contract.appBuildDetails.parse(
    await (await api(`/apps/${app.id}/builds/${build.id}`)).json(),
  );

  expect(details).toMatchObject({
    status: "failed",
    message: "The build stopped before it finished",
  });
  expect(
    contract.appBuild.array().parse(await (await api(`/apps/${app.id}/builds`)).json())[0]?.status,
  ).toBe("failed");
});

it("keeps the token of a running build valid when its run is repeated", async () => {
  const app = await createApp("joined-build");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  const statuses: number[] = [];

  await run(
    build.id,
    ci(async (first) => {
      // A repeated run gets its own token while the first run still makes requests.
      await run(
        build.id,
        ci(async (second) => {
          statuses.push((await asBuild(first, `/apps/${app.id}/network`)).status);
          statuses.push((await asBuild(second, `/apps/${app.id}/network`)).status);

          return { status: "failed", message: "Stopped", log: "" };
        }),
      );

      // Both tokens end with the build.
      statuses.push((await asBuild(first, `/apps/${app.id}/network`)).status);

      return { status: "failed", message: "Stopped", log: "" };
    }),
  );

  expect(statuses).toEqual([200, 200, 401]);
});

it("ends the token of a build whose workflow ended and keeps a finished outcome", async () => {
  const app = await createApp("ended-workflow");
  heads.set(app.id, commit);
  const stopped = contract.appBuild.parse(await (await startBuild(app.id)).json());
  const finished = contract.appBuild.parse(await (await startBuild(app.id)).json());

  await run(
    stopped.id,
    ci(async (request) => {
      ended.add(stopped.id);
      await api(`/apps/${app.id}/builds/${stopped.id}`);
      expect((await asBuild(request, `/apps/${app.id}/network`)).status).toBe(401);

      return { status: "failed", message: "Stopped", log: "" };
    }),
  );

  await run(finished.id, succeeded);
  ended.add(finished.id);

  const [record] = await environment.database.db
    .select()
    .from(appBuilds)
    .where(eq(appBuilds.id, stopped.id));

  expect(record).toMatchObject({ status: "failed" });
  expect(
    contract.appBuildDetails.parse(
      await (await api(`/apps/${app.id}/builds/${finished.id}`)).json(),
    ).status,
  ).toBe("succeeded");
});

it("fails a build that published another commit", async () => {
  const app = await createApp("other-commit");
  heads.set(app.id, commit);
  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());
  // Another commit of the branch, stored after the build started.
  const other = "d".repeat(40);
  heads.set(app.id, other);

  await run(
    build.id,
    ci(async (request) => {
      expect((await deploy(request, { ...request.source, commit: other })).status).toBe(200);

      return { status: "succeeded", log: "" };
    }),
  );

  const [record] = await environment.database.db
    .select()
    .from(appBuilds)
    .where(eq(appBuilds.id, build.id));

  expect(record?.status).toBe("failed");
  expect(record?.message).toBe(`The build published ${other} instead of ${commit}`);
  expect(record?.deploymentId).not.toBeNull();
});

it("accepts a build's token only for the build it names", async () => {
  const app = await createApp("forged-build");
  heads.set(app.id, commit);
  const first = contract.appBuild.parse(await (await startBuild(app.id)).json());
  const second = contract.appBuild.parse(await (await startBuild(app.id)).json());

  const statuses: number[] = [];

  await run(
    second.id,
    ci(async () => {
      await run(
        first.id,
        ci(async (request) => {
          const sealed = request.platform.token.slice(request.platform.token.indexOf(".") + 1);

          // The sealed part of one build's token does not open for another build.
          for (const token of [`wfb_${second.id}.${sealed}`, `wfb_${second.id}`, "wfb_"])
            statuses.push(
              (
                await asBuild(
                  { ...request, platform: { ...request.platform, token } },
                  `/apps/${app.id}/network`,
                )
              ).status,
            );

          return { status: "failed", message: "Stopped", log: "" };
        }),
      );

      return { status: "failed", message: "Stopped", log: "" };
    }),
  );

  expect(statuses).toEqual([401, 401, 401]);
});

it("starts only builds the installation admits, with the container time it grants", async () => {
  const app = await createApp("admitted-build");
  heads.set(app.id, commit);

  admission = () => new InvalidOperation({ code: "FORBIDDEN", message: "Builds are not enabled" });

  const refused = await startBuild(app.id);

  expect(refused.status).toBe(403);
  expect(await refused.text()).toMatch(/Builds are not enabled/);
  expect(started).toEqual([]);
  expect(
    await environment.database.db.select().from(appBuilds).where(eq(appBuilds.appId, app.id)),
  ).toEqual([]);

  admission = () => 600;

  const build = contract.appBuild.parse(await (await startBuild(app.id)).json());

  expect(admitted.at(-1)).toEqual({
    id: build.id,
    organizationId: environment.application.organizationId,
    appId: app.id,
  });

  await run(build.id, succeeded);

  // The build stops when its granted time after admission is over, and the
  // time it used is settled as it finishes.
  expect(ciRequests[0]?.deadline).toBe(Date.parse(build.createdAt) + 600 * 1000);
  expect(settled).toEqual([{ id: build.id, seconds: 60 }]);

  // A repeated run settles nothing again.
  await run(build.id, succeeded);
  expect(settled).toHaveLength(1);
});

it("keeps the reservation of builds that end without the CI's time", async () => {
  const app = await createApp("unsettled-time");
  heads.set(app.id, commit);
  const failing = contract.appBuild.parse(await (await startBuild(app.id)).json());
  const stopped = contract.appBuild.parse(await (await startBuild(app.id)).json());

  // Their containers may still run until their deadline.
  await failBuild(environment.database.db, failing.id, "The build could not finish");
  ended.add(stopped.id);
  await api(`/apps/${app.id}/builds/${stopped.id}`);

  expect(settled).toEqual([]);
  expect(
    (
      await environment.database.db
        .select({ status: appBuilds.status })
        .from(appBuilds)
        .where(eq(appBuilds.appId, app.id))
    ).map(({ status }) => status),
  ).toEqual(["failed", "failed"]);
});
