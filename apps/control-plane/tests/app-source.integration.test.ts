import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { eq } from "drizzle-orm";
import * as contract from "@platform/contracts";
import type { SourceBackend } from "../src/lib/server/source-backend.ts";
import { createAppSource } from "../src/lib/server/app-source.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createUploadService } from "../src/lib/server/uploads.ts";
import { apps, artifacts, deployments } from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";

describe("App source repositories", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let service: ReturnType<typeof createAppService>;
  let source: ReturnType<typeof createAppSource>;
  let creator: Awaited<ReturnType<typeof person>>;
  let colleague: Awaited<ReturnType<typeof person>>;
  const repositories = new Map<string, Map<string, string>>();
  const url = (id: string) => `https://git.example.test/apps/${id}.git`;

  const backend = {
    repository: vi.fn(async (id: string) => (repositories.has(id) ? { url: url(id) } : null)),
    create: vi.fn(async (id: string) => {
      repositories.set(id, new Map());

      return { url: url(id) };
    }),
    head: vi.fn(async (id: string, branch: string) => repositories.get(id)?.get(branch) ?? null),
    hasCommit: vi.fn(async (id: string, commit: string) =>
      [...(repositories.get(id)?.values() ?? [])].includes(commit),
    ),
    credential: vi.fn(async (id: string, scope: "read" | "write") => ({
      url: url(id),
      username: "x",
      password: `test-${scope}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })),
    remove: vi.fn(async (id: string) => {
      repositories.delete(id);
    }),
  } satisfies SourceBackend;

  const person = async (name: string) => {
    const record = environment.users.createUser({ name, email: `${name}@example.test` });
    await environment.users.saveUser(record);
    await environment.linkMicrosoftUser(record.id);

    return {
      ...record,
      application: environment.application,
      role: "member" as const,
      admin: false,
      creator: true,
    };
  };

  beforeAll(async () => {
    environment = await createTestEnvironment();
    service = createAppService(environment.database.db, environment.configuration);
    source = createAppSource(environment.database.db, backend);
    creator = await person("source-author");
    colleague = await person("source-colleague");
  });
  beforeEach(async () => {
    await environment.database.db.delete(apps);
    repositories.clear();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await environment.close();
  });

  const create = async () =>
    (
      await service.create(creator, {
        slug: "source-app",
        displayName: "Source app",
        parentId: null,
      })
    ).unwrap();

  it("distinguishes unsupported installations, empty repositories and saved commits", async () => {
    const app = await create();
    expect((await createAppSource(environment.database.db).read(creator, app.id)).unwrap()).toEqual(
      { supported: false, available: false, repository: null, deployed: null },
    );
    expect((await source.read(creator, app.id)).unwrap()).toMatchObject({
      supported: true,
      available: false,
      repository: null,
    });
    expect((await source.prepare(creator, app.id)).unwrap().repository).toEqual({
      url: url(app.id),
      branch: "main",
      commit: null,
    });
    expect((await source.read(creator, app.id)).unwrap().available).toBe(false);
    repositories.get(app.id)?.set("main", "a".repeat(40));
    expect((await source.read(creator, app.id)).unwrap()).toMatchObject({
      available: true,
      repository: { commit: "a".repeat(40) },
      deployed: null,
    });
  });

  it("checks deployment branches without creating apps, changing settings or contacting Git", async () => {
    const target = { slug: "source-app" };
    expect((await source.deploymentTarget(creator, target)).unwrap()).toEqual({
      supported: true,
      branch: "main",
      preview: false,
    });
    expect(await environment.database.db.select().from(apps)).toEqual([]);
    expect(
      (await createAppSource(environment.database.db).deploymentTarget(creator, target)).unwrap()
        .supported,
    ).toBe(false);
    const app = await create();
    const before = await environment.database.db.select().from(apps);

    for (const input of [target, { appId: app.id }]) {
      expect((await source.deploymentTarget(creator, input)).unwrap()).toEqual({
        supported: true,
        branch: "main",
        preview: false,
      });
    }

    expect(await source.deploymentTarget(colleague, { appId: app.id })).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect((await source.deploymentTarget(colleague, target)).unwrap().branch).toBe("main");
    expect(await environment.database.db.select().from(apps)).toEqual(before);
    expect(backend.repository).not.toHaveBeenCalled();
    expect(backend.create).not.toHaveBeenCalled();
    expect(backend.head).not.toHaveBeenCalled();

    const preview = (
      await service.create(creator, {
        slug: "source-app-review",
        displayName: "Review",
        parentId: app.id,
        previewBranch: "review",
      })
    ).unwrap();

    expect((await source.deploymentTarget(creator, { appId: preview.id })).unwrap()).toEqual({
      supported: true,
      branch: "review",
      preview: true,
    });
  });

  it("checks management grants and organization before issuing repository credentials", async () => {
    const app = await create();
    await source.prepare(creator, app.id);
    expect(await source.read(colleague, app.id)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await source.credential(colleague, app.id, "write")).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(backend.credential).not.toHaveBeenCalled();
    (await service.grant(creator, app.id, colleague.id)).unwrap();
    (await source.credential(colleague, app.id, "read")).unwrap();
    expect(backend.credential).toHaveBeenLastCalledWith(app.id, "read");
    (await source.credential(colleague, app.id, "write")).unwrap();
    expect(backend.credential).toHaveBeenLastCalledWith(app.id, "write");

    const foreign = {
      ...creator,
      application: { ...creator.application, organizationId: "another-organization", admin: true },
    };

    expect(await source.credential(foreign, app.id, "write")).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    (await service.revoke(creator, app.id, colleague.id)).unwrap();
    expect(await source.credential(colleague, app.id, "write")).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("shares the main repository with previews while keeping their branch selection separate", async () => {
    const app = await create();

    const preview = (
      await service.create(creator, {
        slug: "source-app-review",
        displayName: "Review",
        parentId: app.id,
        previewBranch: "review",
      })
    ).unwrap();

    const [main, branch] = await Promise.all([
      source.prepare(creator, app.id),
      source.prepare(creator, preview.id),
    ]);

    expect(main.unwrap().repository?.url).toBe(branch.unwrap().repository?.url);
    expect(backend.create).toHaveBeenCalledTimes(1);
    expect((await source.read(creator, app.id)).unwrap().repository?.branch).toBe("main");
    expect((await source.read(creator, preview.id)).unwrap().repository?.branch).toBe("review");
    (await source.credential(creator, preview.id, "write")).unwrap();
    expect(backend.credential).toHaveBeenLastCalledWith(app.id, "write");
    await environment.database.db
      .update(apps)
      .set({ state: "deleting" })
      .where(eq(apps.id, preview.id));
    expect(await source.credential(creator, preview.id, "write")).toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect((await source.read(creator, preview.id)).unwrap().repository?.branch).toBe("review");
    expect(backend.remove).not.toHaveBeenCalled();
  });

  it("keeps the main branch and preview assignment fixed during preparation", async () => {
    const app = await create();

    const preview = (
      await service.create(creator, {
        slug: "source-app-review",
        displayName: "Review",
        parentId: app.id,
        previewBranch: "feature/review",
      })
    ).unwrap();

    const before = await environment.database.db.select().from(apps);
    const prepared = (await source.prepare(creator, preview.id)).unwrap();
    expect(prepared).toEqual({
      organizationId: app.organizationId,
      repository: { url: url(app.id), branch: "feature/review", commit: null },
      preview: true,
    });
    expect((await source.prepare(creator, app.id)).unwrap().repository?.branch).toBe("main");
    expect(await environment.database.db.select().from(apps)).toEqual(before);
  });

  it("derives preview names from Git branches and keeps unnamed previews without a source binding", async () => {
    const app = await create();
    const branch = "feature/review";
    const name = await contract.previewNameFromBranch(branch);

    const preview = (
      await service.create(creator, {
        slug: "source-app-review",
        displayName: "Review",
        parentId: app.id,
        previewBranch: branch,
      })
    ).unwrap();

    expect(preview.hostname).toBe(`${name}.${app.hostname}`);
    expect(
      await service.create(creator, {
        slug: "duplicate-review",
        displayName: "Duplicate",
        parentId: app.id,
        previewBranch: branch,
      }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(
      await service.create(creator, {
        slug: "renamed-review",
        displayName: "Renamed",
        parentId: app.id,
        previewBranch: branch,
        previewName: "other-name",
      }),
    ).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(
      await service.create(creator, {
        slug: "main-review",
        displayName: "Main",
        parentId: app.id,
        previewBranch: "main",
      }),
    ).toMatchObject({ error: { code: "BAD_REQUEST" } });
    (await source.prepare(creator, app.id)).unwrap();

    const unnamed = (
      await service.create(creator, {
        slug: "manual-review",
        displayName: "Manual",
        parentId: app.id,
      })
    ).unwrap();

    expect((await source.read(creator, unnamed.id)).unwrap().repository).toBeNull();
    expect(await source.prepare(creator, unnamed.id)).toMatchObject({
      error: { code: "CONFLICT" },
    });
  });

  it.each([false, true])(
    "rejects source metadata for the wrong branch (preview: %s)",
    async (preview) => {
      const app = await create();

      const target = preview
        ? (
            await service.create(creator, {
              slug: "source-app-review",
              displayName: "Review",
              parentId: app.id,
              previewBranch: "review",
            })
          ).unwrap()
        : app;

      const uploads = createUploadService(
        environment.database.db,
        createStorage(environment.configuration),
        environment.configuration,
        undefined,
        backend,
      );

      const metadata = contract.workerMetadata.parse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
        source: { branch: "different", commit: "f".repeat(40), directory: "." },
      });

      expect(
        await uploads.publish(creator, target.id, metadata, [], crypto.randomUUID()),
      ).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: "The deployment source branch does not match this app",
        },
      });
      expect(backend.hasCommit).not.toHaveBeenCalled();
    },
  );

  it("retains the deployed source reference when the branch advances", async () => {
    const app = await create();
    (await source.prepare(creator, app.id)).unwrap();
    const deployed = { commit: "a".repeat(40), branch: "main", directory: "apps/mail" };
    const artifactId = crypto.randomUUID();
    const deploymentId = crypto.randomUUID();

    const metadata = contract.workerMetadata.parse({
      main_module: "worker.js",
      bindings: [],
      compatibility_date: "2026-10-01",
      assets: { upload_session: crypto.randomUUID(), binding: "ASSETS" },
      source: deployed,
    });

    await environment.database.db
      .insert(artifacts)
      .values({ id: artifactId, appId: app.id, metadata, modules: [], manifest: {} });
    await environment.database.db.insert(deployments).values({
      id: deploymentId,
      appId: app.id,
      artifactId,
      status: "succeeded",
      requestId: crypto.randomUUID(),
    });
    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: deploymentId })
      .where(eq(apps.id, app.id));
    repositories.get(app.id)?.set("main", "b".repeat(40));
    const result = (await source.read(creator, app.id)).unwrap();
    expect(result.deployed).toEqual(deployed);

    const local = createAppService(
      environment.database.db,
      environment.configuration,
      undefined,
      undefined,
      true,
    );

    expect((await local.get(creator, app.id)).unwrap().source).toEqual({
      supported: true,
      branch: "main",
      deployed,
    });
    expect((await local.list(creator)).unwrap()[0]?.source.deployed).toEqual(deployed);
    expect(result.repository?.commit).toBe("b".repeat(40));
    expect(contract.executionWorkerMetadata(metadata)).not.toHaveProperty("source");
    backend.head.mockRejectedValueOnce(new Error("Synthetic Git outage"));
    expect((await source.read(creator, app.id)).unwrap()).toEqual({
      supported: true,
      available: false,
      repository: null,
      deployed,
      error: "The source repository is unavailable",
    });
  });

  it("separates app discovery from live repository details and protects Git credentials", async () => {
    const app = await create();

    const runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      storage: createStorage(environment.configuration, memoryStorage()),
      reporting: environment.reporting,
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
      source: backend,
    })();

    const api = createApi(runtime);
    const login = await environment.users.login({ userId: creator.id });

    const request = (path: string, method = "GET") => {
      const options: RequestInit = {
        method,
        headers: {
          ...Object.fromEntries(new Headers(login.headers)),
          origin: environment.configuration.PLATFORM_URL,
          "content-type": "application/json",
        },
      };

      if (method === "POST") options.body = "{}";

      return api(new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, options));
    };

    const prepared = await request(`/apps/${app.id}/source/prepare`, "POST");
    expect(prepared.status).toBe(200);
    expect(contract.sourcePreparation.parse(await prepared.json())).toEqual({
      organizationId: app.organizationId,
      repository: { url: url(app.id), branch: "main", commit: null },
      preview: false,
    });

    for (const scope of ["read", "write"] as const) {
      const response = await request(`/apps/${app.id}/source/${scope}-credential`, "POST");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(contract.sourceCredential.parse(await response.json()).password).toBe(`test-${scope}`);
      expect(backend.credential).toHaveBeenLastCalledWith(app.id, scope);
    }

    repositories.get(app.id)?.set("main", "c".repeat(40));
    backend.repository.mockClear();
    backend.head.mockClear();

    for (const path of ["/apps", `/apps/${app.id}`, `/apps/by-name/${app.slug}`]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();

      const status =
        path === "/apps"
          ? contract.app.array().parse(body)[0]?.source
          : contract.app.parse(body).source;

      expect(status).toEqual({ supported: true, branch: "main", deployed: null });
    }

    expect(backend.repository).not.toHaveBeenCalled();
    expect(backend.head).not.toHaveBeenCalled();
    const details = await request(`/apps/${app.id}/source`);
    expect(contract.appSource.parse(await details.json())).toMatchObject({
      available: true,
      repository: { commit: "c".repeat(40) },
    });
    expect((await request(`/apps/${app.id}/source`, "PUT")).status).toBe(404);

    const branchChange = await api(
      new Request(
        `${environment.configuration.PLATFORM_URL}/api/v1/apps/${app.id}/source/prepare`,
        {
          method: "POST",
          headers: {
            ...Object.fromEntries(new Headers(login.headers)),
            origin: environment.configuration.PLATFORM_URL,
            "content-type": "application/json",
          },
          body: JSON.stringify({ branch: "release" }),
        },
      ),
    );

    expect(branchChange.status).toBe(400);
    expect((await source.deploymentTarget(creator, { appId: app.id })).unwrap().branch).toBe(
      "main",
    );
    backend.repository.mockRejectedValueOnce(new Error("Synthetic Git outage"));
    const failedDetails = await request(`/apps/${app.id}/source`);
    expect(contract.appSource.parse(await failedDetails.json()).error).toBe(
      "The source repository is unavailable",
    );

    backend.repository.mockRejectedValueOnce(new Error("Synthetic Git outage"));
    expect((await request(`/apps/${app.id}/source/prepare`, "POST")).status).toBe(503);
    expect(
      (
        await api(
          new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps/${app.id}/source`),
        )
      ).status,
    ).toBe(401);
  });

  it("serves app lists and details while an explicit Git read is blocked", async () => {
    const app = await create();
    repositories.set(app.id, new Map([["main", "a".repeat(40)]]));
    const database = createDatabase(environment.configuration, 1);
    const gate = new EventEmitter();
    const release = once(gate, "release");

    const slowBackend = {
      ...backend,
      repository: vi.fn(async (id: string) => {
        await release;

        return backend.repository(id);
      }),
    };

    const runtime = await createRuntime({
      configuration: environment.configuration,
      database,
      settings: environment.settings,
      storage: createStorage(environment.configuration, memoryStorage()),
      reporting: environment.reporting,
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
      source: slowBackend,
    })();

    const login = await environment.users.login({ userId: creator.id });
    const api = createApi(runtime);
    const details = runtime.source.read(creator, app.id);

    try {
      await expect.poll(() => slowBackend.repository.mock.calls.length).toBe(1);

      for (const path of ["/apps", `/apps/${app.id}`, `/apps/by-name/${app.slug}`]) {
        const response = await api(
          new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, {
            headers: login.headers,
          }),
        );

        expect(response.status).toBe(200);
        const body: unknown = await response.json();

        const summary =
          path === "/apps"
            ? contract.app.array().parse(body)[0]?.source
            : contract.app.parse(body).source;

        expect(summary).toEqual({ supported: true, branch: "main", deployed: null });
      }

      expect(slowBackend.repository).toHaveBeenCalledTimes(1);
      expect(backend.head).not.toHaveBeenCalled();
      gate.emit("release");
      expect((await details).unwrap().repository?.commit).toBe("a".repeat(40));
    } finally {
      gate.emit("release");
      await details;
      await database.close();
    }
  });

  it("uses the configured backend when deleting a main app and retains it when deleting a preview", async () => {
    const runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      storage: createStorage(environment.configuration, memoryStorage()),
      reporting: environment.reporting,
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
      source: backend,
    })();

    const app = await create();

    const preview = (
      await service.create(creator, { slug: "review", displayName: "Review", parentId: app.id })
    ).unwrap();

    (await source.prepare(creator, app.id)).unwrap();

    const { agent } = (
      await runtime.agents.create({ ...creator, admin: true }, { name: "Source removal" })
    ).unwrap();

    (await service.remove(creator, preview.id)).unwrap();

    const finish = async () => {
      const job = (await runtime.jobs.claim(agent.id)).unwrap();

      if (!job) throw new Error("Missing removal job");

      const result = {
        leaseToken: job.leaseToken,
        outcome: "succeeded" as const,
        message: "Removed",
      };

      return { job, result };
    };

    const child = await finish();
    (await runtime.jobs.complete(agent.id, child.job.id, child.result)).unwrap();
    expect(backend.remove).not.toHaveBeenCalled();
    expect(repositories.has(app.id)).toBe(true);

    (await service.remove(creator, app.id)).unwrap();
    const parent = await finish();
    backend.remove.mockRejectedValueOnce(new Error("Synthetic Git outage"));
    const failed = await runtime.jobs.complete(agent.id, parent.job.id, parent.result);
    expect(failed).toMatchObject({
      error: { _tag: "StorageUnavailable" },
    });
    expect((await service.get(creator, app.id)).unwrap().state).toBe("deleting");
    expect(repositories.has(app.id)).toBe(true);
    (await runtime.jobs.complete(agent.id, parent.job.id, parent.result)).unwrap();
    expect(backend.remove).toHaveBeenLastCalledWith(app.id);
    expect(repositories.has(app.id)).toBe(false);
    expect(await service.get(creator, app.id)).toMatchObject({ error: { code: "NOT_FOUND" } });
    (await runtime.jobs.complete(agent.id, parent.job.id, parent.result)).unwrap();
    expect(backend.remove).toHaveBeenCalledTimes(2);
  });

  it("rejects a deployment commit that is not stored in this app's repository", async () => {
    const app = await create();
    const storage = createStorage(environment.configuration);

    const uploads = createUploadService(
      environment.database.db,
      storage,
      environment.configuration,
      undefined,
      backend,
    );

    const metadata = contract.workerMetadata.parse({
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
      source: { branch: "main", commit: "f".repeat(40), directory: "." },
    });

    const result = await uploads.publish(creator, app.id, metadata, [], crypto.randomUUID());
    expect(result).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "The deployment source commit is not stored in this app's repository",
      },
    });
    expect(backend.hasCommit).toHaveBeenCalledWith(app.id, "f".repeat(40));
    expect(await environment.database.db.select().from(deployments)).toEqual([]);
  });
});
