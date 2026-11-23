import { createConnectionService } from "../src/lib/server/connections.ts";
import { connectionRequests } from "../src/lib/server/schema.ts";
import { organization } from "../src/lib/server/auth-schema.ts";
import { checkServiceConsumers } from "../src/lib/server/app-services.ts";
import { Result } from "better-result";
import { transact } from "../src/lib/server/transactions.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { recordInstallationRuntime, seedDeployment } from "./cloudflare-deployment.fixture.ts";
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
  let installationRuntime: Awaited<ReturnType<typeof recordInstallationRuntime>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
    (await initializeCloudflareRuntime(environment.database.db)).unwrap();
    installationRuntime = await recordInstallationRuntime(environment.database.db, storage);
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
        registerCloudflareOperation(environment.database.db, entry.command),
      ),
    );

    for (const attempt of attempts) expect(attempt.unwrap().id).toBe(entry.command.id);
    expect(await environment.database.db.select().from(cloudflareOperations)).toHaveLength(1);
    expect(await environment.database.db.select().from(deployments)).toHaveLength(1);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
  });

  it("targets the installation runtime for apps of every organization", async () => {
    const organizationId = crypto.randomUUID();
    await environment.database.db
      .insert(organization)
      .values({ id: organizationId, name: "Tenant", slug: "tenant", createdAt: new Date() });
    await environment.database.db
      .insert(organizationRuntimes)
      .values({ organizationId, executor: "cloudflare", appHostnameSuffix: "tenant" });

    const appId = crypto.randomUUID();
    await environment.database.db.insert(apps).values({
      id: appId,
      slug: "tenant-app",
      displayName: "Tenant app",
      organizationId,
      ownerId: "fixture-owner",
      hostname: "tenant-app.example.test",
    });

    const entry = await seedDeployment(environment.database.db, { appId });

    const record = (
      await registerCloudflareOperation(environment.database.db, entry.command)
    ).unwrap();

    expect(record.targets).toEqual([expect.objectContaining({ runtime: installationRuntime })]);

    const [tenant] = await environment.database.db
      .select()
      .from(organizationRuntimes)
      .where(eq(organizationRuntimes.organizationId, organizationId));

    expect(tenant).toMatchObject({ runtime: null, appliedRuntime: null });
  });

  it("rejects app operations before the installation runtime is deployed", async () => {
    await environment.database.db
      .update(organizationRuntimes)
      .set({ appliedRuntime: null })
      .where(eq(organizationRuntimes.organizationId, "widefleet"));

    try {
      const entry = await seedDeployment(environment.database.db);
      const failed = await registerCloudflareOperation(environment.database.db, entry.command);

      expect(failed.isErr() && failed.error).toMatchObject({ code: "CONFLICT" });
      expect(await environment.database.db.select().from(deployments)).toHaveLength(0);
    } finally {
      await environment.database.db
        .update(organizationRuntimes)
        .set({ appliedRuntime: installationRuntime })
        .where(eq(organizationRuntimes.organizationId, "widefleet"));
    }
  });

  it("approves a connection in the same transaction as its hosted command and replays it only once", async () => {
    const principal = {
      id: environment.ownerId,
      name: "Owner",
      email: "owner@example.test",
      role: "owner" as const,
      admin: true,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    };

    const source = await seedDeployment(environment.database.db);
    const target = await seedDeployment(environment.database.db, { entrypoints: ["Reader"] });

    for (const entry of [source, target]) {
      (await registerCloudflareOperation(environment.database.db, entry.command)).unwrap();
      await environment.database.db
        .update(apps)
        .set({ ownerId: principal.id, activeDeploymentId: entry.command.id })
        .where(eq(apps.id, entry.appId));
      await environment.database.db
        .update(deployments)
        .set({ status: "succeeded" })
        .where(eq(deployments.id, entry.command.id));
    }

    const services = createConnectionService(environment.database.db, storage);

    const request = (
      await services.request(
        { ...principal, application: { ...principal.application, admin: false } },
        {
          appId: source.appId,
          app: target.appId,
          binding: "ERP",
          entrypoint: "Reader",
        },
      )
    ).unwrap();

    const command = deploymentCommand.parse({
      kind: "capabilities",
      id: request.id,
      appId: source.appId,
      name: request.binding,
      grant: { app: target.appId, entrypoint: "Reader" },
      actor: principal,
      connectionRequestId: request.id,
      createdAt: new Date().toISOString(),
    });

    const rejectedActor = deploymentCommand.parse({
      ...command,
      actor: { ...principal, application: { ...principal.application, admin: false } },
    });

    expect(
      (await registerCloudflareOperation(environment.database.db, rejectedActor)).isErr(),
    ).toBe(true);

    const [pending] = await environment.database.db
      .select()
      .from(connectionRequests)
      .where(eq(connectionRequests.id, request.id));

    expect(pending?.status).toBe("pending");

    const first = (await registerCloudflareOperation(environment.database.db, command)).unwrap();

    expect(first.result).toMatchObject({
      revision: 1,
      grants: { ERP: { app: target.appId, entrypoint: "Reader" } },
    });
    expect((await registerCloudflareOperation(environment.database.db, command)).unwrap()).toEqual(
      first,
    );
    expect((await services.requests(principal)).unwrap()).toContainEqual({
      ...request,
      status: "approved",
    });
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
  });

  it("records independent commands without claiming or blocking another operation", async () => {
    const first = await seedDeployment(environment.database.db);
    const second = await seedDeployment(environment.database.db);

    for (const entry of [first, second])
      (await registerCloudflareOperation(environment.database.db, entry.command)).unwrap();
    expect(await environment.database.db.select().from(cloudflareOperations)).toHaveLength(2);
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
  });

  it("refreshes secrets using the newest admitted code and persists that choice across retries", async () => {
    const first = await seedDeployment(environment.database.db);
    const second = await seedDeployment(environment.database.db, { appId: first.appId });
    (await registerCloudflareOperation(environment.database.db, first.command)).unwrap();
    (await registerCloudflareOperation(environment.database.db, second.command)).unwrap();

    const refresh = deploymentCommand.parse({
      ...first.command,
      id: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      refreshSecrets: true,
    });

    const accepted = (await registerCloudflareOperation(environment.database.db, refresh)).unwrap();

    expect(accepted.command).toMatchObject({ artifactId: second.artifact.id });
    const third = await seedDeployment(environment.database.db, { appId: first.appId });
    (await registerCloudflareOperation(environment.database.db, third.command)).unwrap();
    expect(
      (await registerCloudflareOperation(environment.database.db, refresh)).unwrap().command,
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

    const original = (await registerCloudflareOperation(environment.database.db, command)).unwrap();

    const retry = (await registerCloudflareOperation(environment.database.db, command)).unwrap();

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

      expect((await registerCloudflareOperation(environment.database.db, command)).isErr()).toBe(
        true,
      );
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

    (await registerCloudflareOperation(environment.database.db, command)).unwrap();
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
