import { checkServiceConsumers } from "../src/lib/server/app-services.ts";
import { Result } from "better-result";
import { transact } from "../src/lib/server/transactions.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";
import { registerCloudflareOperation } from "../src/lib/server/cloudflare-operations.ts";
import { deploymentCommand } from "../src/lib/server/deployment-execution.ts";
import { initializeCloudflareRuntime } from "../src/lib/server/organization-runtime.ts";
import {
  apps,
  agents,
  cloudflareOperations,
  deployments,
  organizationRuntimes,
  jobs,
} from "../src/lib/server/schema.ts";
import { createJobService } from "../src/lib/server/jobs.ts";

const objects = new Map<string, Uint8Array>();

const storage = createArtifactStorage({
  put: async (key, bytes) => {
    if (!objects.has(key)) objects.set(key, bytes);
  },
  get: async (key) => {
    const bytes = objects.get(key);

    if (!bytes) throw new Error("Object not found");

    return bytes;
  },
  exists: async (key) => objects.has(key),
  async *list(prefix) {
    for (const [key, bytes] of objects)
      if (key.startsWith(prefix)) yield { key, size: bytes.length };
  },
  remove: async (keys) => {
    for (const key of keys) objects.delete(key);
  },
});

describe("Cloudflare operation history", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
    (await initializeCloudflareRuntime(environment.database.db)).unwrap();
  });
  beforeEach(async () => {
    await environment.database.db.delete(apps);
  });
  afterAll(async () => {
    await environment.close();
  });

  it("materializes the same accepted command once across request and Workflow races", async () => {
    const entry = await seedDeployment(environment.database.db);
    expect(await environment.database.db.select().from(deployments)).toHaveLength(0);

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        registerCloudflareOperation(environment.database.db, storage, entry.command),
      ),
    );

    for (const attempt of attempts) expect(attempt.unwrap().id).toBe(entry.command.id);
    expect(await environment.database.db.select().from(cloudflareOperations)).toHaveLength(1);
    expect(await environment.database.db.select().from(deployments)).toHaveLength(1);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
  });

  it("records independent commands without claiming or blocking another operation", async () => {
    const first = await seedDeployment(environment.database.db);
    const second = await seedDeployment(environment.database.db);

    for (const entry of [first, second])
      (await registerCloudflareOperation(environment.database.db, storage, entry.command)).unwrap();
    expect(await environment.database.db.select().from(cloudflareOperations)).toHaveLength(2);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
  });

  it("refreshes secrets using the newest admitted code and persists that choice across retries", async () => {
    const first = await seedDeployment(environment.database.db);
    const second = await seedDeployment(environment.database.db, { appId: first.appId });
    (await registerCloudflareOperation(environment.database.db, storage, first.command)).unwrap();
    (await registerCloudflareOperation(environment.database.db, storage, second.command)).unwrap();

    const refresh = deploymentCommand.parse({
      ...first.command,
      id: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      refreshSecrets: true,
    });

    const accepted = (
      await registerCloudflareOperation(environment.database.db, storage, refresh)
    ).unwrap();

    expect(accepted.command).toMatchObject({ artifactId: second.artifact.id });
    const third = await seedDeployment(environment.database.db, { appId: first.appId });
    (await registerCloudflareOperation(environment.database.db, storage, third.command)).unwrap();
    expect(
      (await registerCloudflareOperation(environment.database.db, storage, refresh)).unwrap()
        .command,
    ).toEqual(accepted.command);

    const [deployment] = await environment.database.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, refresh.id));

    expect(deployment?.artifactId).toBe(second.artifact.id);
  });

  it("applies access inheritance once and keeps settings saved before the first deployment", async () => {
    const first = await seedDeployment(environment.database.db);
    const preview = await seedDeployment(environment.database.db);
    await environment.database.db
      .update(apps)
      .set({ parentId: first.appId })
      .where(eq(apps.id, preview.appId));

    const command = deploymentCommand.parse({
      kind: "access",
      id: crypto.randomUUID(),
      appId: first.appId,
      actor: { id: "fixture-owner", admin: false, application: environment.application },
      input: { revision: 1, groups: ["support"] },
      createdAt: new Date().toISOString(),
    });

    const original = (
      await registerCloudflareOperation(environment.database.db, storage, command)
    ).unwrap();

    const retry = (
      await registerCloudflareOperation(environment.database.db, storage, command)
    ).unwrap();

    expect(retry.result).toEqual(original.result);
    expect(original.result).toMatchObject({ revision: 2, state: "saved", groups: ["support"] });

    const [child] = await environment.database.db
      .select()
      .from(apps)
      .where(eq(apps.id, preview.appId));

    expect(child).toMatchObject({
      accessRevision: 2,
      accessGroups: ["support"],
      appliedAccessRevision: null,
    });
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
  });

  it("rejects unauthorized configuration and stale access revisions without history or mutations", async () => {
    const entry = await seedDeployment(environment.database.db);

    for (const [actor, revision] of [
      ["stranger", 1],
      ["fixture-owner", 0],
    ] as const) {
      const command = deploymentCommand.parse({
        kind: "access",
        id: crypto.randomUUID(),
        appId: entry.appId,
        actor: { id: actor, admin: false, application: environment.application },
        input: { revision, groups: [] },
        createdAt: new Date().toISOString(),
      });

      expect(
        (await registerCloudflareOperation(environment.database.db, storage, command)).isErr(),
      ).toBe(true);
    }

    expect(await environment.database.db.select().from(cloudflareOperations)).toHaveLength(0);
    const [app] = await environment.database.db.select().from(apps).where(eq(apps.id, entry.appId));
    expect(app?.accessGroups).toEqual(["engineering"]);
  });

  it("prevents agents from claiming hosted work and refuses conversion of an occupied execution", async () => {
    const entry = await seedDeployment(environment.database.db);
    const agentId = crypto.randomUUID();
    await environment.database.db.insert(agents).values({
      id: agentId,
      organizationId: entry.organizationId,
      name: "Fixture",
      tokenHash: crypto.randomUUID(),
    });
    expect(
      await createJobService(environment.database.db, storage, "unused-test-key").claim(
        agentId,
        true,
      ),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    await environment.database.db
      .update(organizationRuntimes)
      .set({ executor: "agent" })
      .where(eq(organizationRuntimes.organizationId, entry.organizationId));
    expect(await initializeCloudflareRuntime(environment.database.db)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    await environment.database.db
      .update(organizationRuntimes)
      .set({ executor: "cloudflare" })
      .where(eq(organizationRuntimes.organizationId, entry.organizationId));
  });
  it("protects a published grant whose SQL activation receipt was lost", async () => {
    const entry = await seedDeployment(environment.database.db);

    const target = await seedDeployment(environment.database.db, {
      web: false,
      entrypoints: ["default", "Reader"],
    });

    await environment.database.db.insert(deployments).values({
      id: target.deploymentId,
      appId: target.appId,
      artifactId: target.artifact.id,
      requestId: crypto.randomUUID(),
      status: "succeeded",
    });
    await environment.database.db
      .update(apps)
      .set({ state: "active", activeDeploymentId: target.deploymentId })
      .where(eq(apps.id, target.appId));

    const command = deploymentCommand.parse({
      kind: "capabilities",
      id: crypto.randomUUID(),
      appId: entry.appId,
      actor: {
        id: "fixture-owner",
        admin: true,
        application: { ...environment.application, admin: true },
      },
      name: "ERP",
      grant: { app: target.appId, entrypoint: "Reader" },
      createdAt: new Date().toISOString(),
    });

    (await registerCloudflareOperation(environment.database.db, storage, command)).unwrap();
    await environment.database.db
      .update(apps)
      .set({ capabilities: {}, capabilityRevision: 2 })
      .where(eq(apps.id, entry.appId));

    const prepare = () =>
      transact(environment.database.db, async (transaction) => {
        await checkServiceConsumers(
          transaction,
          { id: target.appId, organizationId: target.organizationId },
          ["default"],
        );

        return Result.ok(true);
      });

    const blocked = await prepare();
    expect(blocked.isErr()).toBe(true);

    if (blocked.isErr())
      expect(blocked.error.message).toContain("Disconnect active and pending app connections");
    await environment.database.db
      .update(apps)
      .set({ appliedCapabilityRevision: 2, appliedCapabilities: { revision: 2, grants: {} } })
      .where(eq(apps.id, entry.appId));
    expect((await prepare()).isOk()).toBe(true);
  });
});
