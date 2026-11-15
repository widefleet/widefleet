import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as contract from "@platform/contracts";
import type { SourceBackend } from "../src/lib/server/source-backend.ts";
import { createAppSource } from "../src/lib/server/app-source.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createUploadService } from "../src/lib/server/uploads.ts";
import { apps, artifacts, deployments } from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";

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
    expect((await source.setup(creator, app.id, {})).unwrap()).toEqual({
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

  it("checks management grants and organization before issuing repository credentials", async () => {
    const app = await create();
    await source.setup(creator, app.id, {});
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
      })
    ).unwrap();

    const [main, branch] = await Promise.all([
      source.setup(creator, app.id, {}),
      source.setup(creator, preview.id, { branch: "preview/review" }),
    ]);

    expect(main.unwrap().url).toBe(branch.unwrap().url);
    expect(backend.create).toHaveBeenCalledTimes(1);
    expect((await source.read(creator, app.id)).unwrap().repository?.branch).toBe("main");
    expect((await source.read(creator, preview.id)).unwrap().repository?.branch).toBe(
      "preview/review",
    );
    (await source.credential(creator, preview.id, "write")).unwrap();
    expect(backend.credential).toHaveBeenLastCalledWith(app.id, "write");
    await environment.database.db
      .update(apps)
      .set({ state: "deleting" })
      .where(eq(apps.id, preview.id));
    expect(await source.credential(creator, preview.id, "write")).toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect((await source.read(creator, preview.id)).unwrap().repository?.branch).toBe(
      "preview/review",
    );
    expect(backend.remove).not.toHaveBeenCalled();
  });

  it("retains the deployed source reference when the branch advances or changes", async () => {
    const app = await create();
    (await source.setup(creator, app.id, {})).unwrap();
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
    expect(result.repository?.commit).toBe("b".repeat(40));
    (await source.setup(creator, app.id, { branch: "release" })).unwrap();
    expect((await source.read(creator, app.id)).unwrap()).toMatchObject({
      available: false,
      repository: { branch: "release", commit: null },
      deployed,
    });
    expect(contract.executionWorkerMetadata(metadata)).not.toHaveProperty("source");
  });

  it("serves the same authorized repository through app discovery, setup and Git credentials", async () => {
    const app = await create();

    const runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      storage: createStorage(environment.configuration),
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
    });

    for (const scope of ["read", "write"] as const) {
      const response = await request(`/apps/${app.id}/source/${scope}-credential`, "POST");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(contract.sourceCredential.parse(await response.json()).password).toBe(`test-${scope}`);
      expect(backend.credential).toHaveBeenLastCalledWith(app.id, scope);
    }

    repositories.get(app.id)?.set("main", "c".repeat(40));
    const listed = contract.app.array().parse(await (await request("/apps")).json());
    expect(listed[0]?.source).toMatchObject({
      supported: true,
      available: true,
      repository: { commit: "c".repeat(40) },
    });
    expect(
      (
        await api(
          new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps/${app.id}/source`),
        )
      ).status,
    ).toBe(401);
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
