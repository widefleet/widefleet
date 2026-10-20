import { Result } from "better-result";
import { connectorFixture, connectorFiles } from "./cloudflare-connector.fixture.ts";
import { prepareConnector } from "../src/lib/server/connector-changes.ts";
import { connectorReference } from "../src/lib/server/connector-package.ts";
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
  connectors,
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

    const reference = connectorReference.parse({
      name: "receipt-connector",
      checksum: "b".repeat(64),
      entrypoints: ["default", "Reader"],
      classes: [],
    });

    await environment.database.db.insert(connectors).values({
      organizationId: entry.organizationId,
      name: reference.name,
      package: reference,
      appliedPackage: reference,
      jobId: crypto.randomUUID(),
    });

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
      grant: { connector: reference.name, entrypoint: "Reader" },
      createdAt: new Date().toISOString(),
    });

    (await registerCloudflareOperation(environment.database.db, storage, command)).unwrap();
    await environment.database.db
      .update(apps)
      .set({ capabilities: {}, capabilityRevision: 2 })
      .where(eq(apps.id, entry.appId));
    const replacement = connectorFixture(reference.name);
    replacement.metadata.entrypoints = ["default"];

    const prepare = () =>
      transact(environment.database.db, async (transaction) => {
        const [execution] = await transaction
          .select()
          .from(organizationRuntimes)
          .where(eq(organizationRuntimes.organizationId, entry.organizationId));

        if (!execution) throw new Error("Missing fixture execution");

        return Result.ok(
          await prepareConnector(
            transaction,
            storage,
            execution,
            replacement,
            connectorFiles(replacement),
          ),
        );
      });

    const blocked = await prepare();
    expect(blocked.isErr()).toBe(true);

    if (blocked.isErr())
      expect(blocked.error.message).toContain("Confirm pending app binding changes");
    await environment.database.db
      .update(apps)
      .set({ appliedCapabilityRevision: 2, appliedCapabilities: { revision: 2, grants: {} } })
      .where(eq(apps.id, entry.appId));
    expect((await prepare()).isOk()).toBe(true);
  });
});
