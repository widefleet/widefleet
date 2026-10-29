import { jobs } from "../src/lib/server/schema.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as contract from "@platform/contracts";
import { createTestEnvironment } from "./environment.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createConnectionService } from "../src/lib/server/connections.ts";
import { createAppSecrets } from "../src/lib/server/app-secrets.ts";
import { apps, artifacts, deployments } from "../src/lib/server/schema.ts";
import { decryptSecret } from "../src/lib/server/secret-encryption.ts";
import type { Principal } from "../src/lib/server/identity.ts";

describe("App service connections", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let principal: Principal;
  beforeAll(async () => {
    environment = await createTestEnvironment();
    principal = {
      id: environment.ownerId,
      name: "Owner",
      email: "owner@example.test",
      role: "owner",
      admin: true,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    };
  });
  afterAll(async () => {
    await environment.close();
  });

  const services = () => createConnectionService(environment.database.db);

  const applications = () => createAppService(environment.database.db, environment.configuration);

  const secrets = () =>
    createAppSecrets(environment.database.db, environment.environment.PLATFORM_ENCRYPTION_KEY);

  const app = async (entrypoints: string[] = []) => {
    const app = (
      await applications().create(principal, {
        slug: `app-${crypto.randomUUID()}`,
        displayName: "Service fixture",
        parentId: null,
      })
    ).unwrap();

    const artifactId = crypto.randomUUID();
    const deploymentId = crypto.randomUUID();

    const metadata = contract.workerMetadata.parse({
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      web: false,
      entrypoints,
      assets: { upload_session: artifactId, binding: "ASSETS" },
    });

    await environment.database.db.insert(artifacts).values({
      id: artifactId,
      appId: app.id,
      metadata,
      manifest: {},
      modules: [{ name: "worker.js", type: "esm", size: 1, sha256: "a".repeat(64) }],
    });
    await environment.database.db.insert(deployments).values({
      id: deploymentId,
      appId: app.id,
      artifactId,
      status: "succeeded",
      requestId: crypto.randomUUID(),
    });
    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: deploymentId, state: "active" })
      .where(eq(apps.id, app.id));

    return { ...app, artifactId };
  };

  it("publishes app APIs and restricts grants to administrators in the owning organization", async () => {
    const source = await app();
    const target = await app(["Reader"]);
    expect((await services().services(principal)).unwrap()).toContainEqual({
      appId: target.id,
      slug: target.slug,
      displayName: target.displayName,
      entrypoints: ["Reader"],
    });
    const grant = { app: target.id, entrypoint: "Reader" };
    expect((await services().bind(principal, source.id, "ERP", grant)).unwrap().grants).toEqual({
      ERP: grant,
    });
    expect(
      await services().bind(
        { ...principal, application: { ...principal.application, admin: false } },
        source.id,
        "ERP",
        grant,
      ),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(
      await services().bind(
        { ...principal, application: { organizationId: "foreign", admin: true } },
        source.id,
        "ERP",
        grant,
      ),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(
      await services().bind(principal, source.id, "ERP", { ...grant, entrypoint: "Writer" }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await services().bind(principal, source.id, "ASSETS", grant)).toMatchObject({
      error: { code: "CONFLICT" },
    });
  });

  it("rejects cycles through desired or still-active connections", async () => {
    const a = await app(["Reader"]);
    const b = await app(["Reader"]);
    (await services().bind(principal, a.id, "B", { app: b.id, entrypoint: "Reader" })).unwrap();
    expect(
      await services().bind(principal, b.id, "A", { app: a.id, entrypoint: "Reader" }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    await environment.database.db
      .update(apps)
      .set({
        capabilities: {},
        appliedCapabilities: { revision: 1, grants: { B: { app: b.id, entrypoint: "Reader" } } },
      })
      .where(eq(apps.id, a.id));
    expect(
      await services().bind(principal, b.id, "A", { app: a.id, entrypoint: "Reader" }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(
      await services().bind(principal, a.id, "SELF", { app: a.id, entrypoint: "Reader" }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("blocks deletion and rollback that remove referenced APIs, including pending revocations", async () => {
    const source = await app();
    const target = await app(["Reader"]);
    (
      await services().bind(principal, source.id, "ERP", { app: target.id, entrypoint: "Reader" })
    ).unwrap();
    const oldId = crypto.randomUUID();
    await environment.database.db.insert(artifacts).values({
      id: oldId,
      appId: target.id,
      metadata: contract.workerMetadata.parse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        assets: { upload_session: oldId },
      }),
      manifest: {},
      modules: [],
    });
    expect(
      await applications().rollback(principal, target.id, oldId, crypto.randomUUID()),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await applications().remove(principal, target.id)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    await environment.database.db
      .update(apps)
      .set({
        capabilities: {},
        appliedCapabilities: {
          revision: 1,
          grants: { ERP: { app: target.id, entrypoint: "Reader" } },
        },
      })
      .where(eq(apps.id, source.id));
    expect(await applications().remove(principal, target.id)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    await environment.database.db
      .update(apps)
      .set({ appliedCapabilities: { revision: 2, grants: {} } })
      .where(eq(apps.id, source.id));
    expect((await applications().remove(principal, target.id)).unwrap()).toEqual({
      accepted: true,
    });
  });

  it("keeps encrypted secrets private to their app and deploys changes through its existing lifecycle", async () => {
    const target = await app(["Reader"]);
    const source = await app();
    (
      await services().bind(principal, source.id, "ERP", { app: target.id, entrypoint: "Reader" })
    ).unwrap();
    const result = (await secrets().set(principal, target.id, "TOKEN", "synthetic-value")).unwrap();
    expect(result).toMatchObject({
      names: ["TOKEN"],
      revision: 1,
      deployment: { appId: target.id, artifactId: target.artifactId, status: "queued" },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-value");

    const [record] = await environment.database.db
      .select()
      .from(apps)
      .where(eq(apps.id, target.id));

    const values = contract.appSecretPreparation.shape.values.parse(record?.secrets);
    expect(values["TOKEN"]).not.toBe("synthetic-value");
    expect(
      await decryptSecret(environment.environment.PLATFORM_ENCRYPTION_KEY, values["TOKEN"] ?? ""),
    ).toBe("synthetic-value");
    expect((await secrets().read(principal, source.id)).unwrap().names).toEqual([]);

    const consumer = {
      ...principal,
      id: "consumer-only",
      application: { ...principal.application, admin: false },
    };

    expect(await secrets().read(consumer, target.id)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    const removed = (await secrets().set(principal, target.id, "TOKEN", null)).unwrap();
    expect(removed).toMatchObject({ names: [], revision: 2 });
  });
  it("preserves pending code selection when changing secrets", async () => {
    const target = await app(["Reader"]);
    const latestArtifact = crypto.randomUUID();

    const [original] = await environment.database.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, target.artifactId));

    if (!original) throw new Error("Missing fixture artifact");
    await environment.database.db.insert(artifacts).values({ ...original, id: latestArtifact });
    await environment.database.db.insert(deployments).values({
      id: crypto.randomUUID(),
      appId: target.id,
      artifactId: latestArtifact,
      status: "queued",
      requestId: crypto.randomUUID(),
    });
    const result = (await secrets().set(principal, target.id, "TOKEN", "synthetic-new")).unwrap();
    expect(result.deployment?.artifactId).toBe(latestArtifact);
  });

  it("protects native grants published before their activation acknowledgement", async () => {
    const source = await app();
    const target = await app(["Reader"]);
    await environment.database.db.insert(jobs).values({
      id: crypto.randomUUID(),
      organizationId: "widefleet",
      appId: source.id,
      kind: "configure",
      state: "running",
      capabilities: { revision: 1, grants: { ERP: { app: target.id, entrypoint: "Reader" } } },
    });
    expect(await applications().remove(principal, target.id)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    await environment.database.db
      .update(apps)
      .set({ appliedCapabilityRevision: 2, appliedCapabilities: { revision: 2, grants: {} } })
      .where(eq(apps.id, source.id));
    expect((await applications().remove(principal, target.id)).unwrap()).toEqual({
      accepted: true,
    });
  });
});
