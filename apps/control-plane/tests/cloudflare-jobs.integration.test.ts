import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";
import { createCloudflareJobService } from "../src/lib/server/cloudflare-jobs.ts";
import { completeJob } from "../src/lib/server/job-completion.ts";
import { initializeCloudflareFleet } from "../src/lib/server/fleets.ts";
import { apps, agents, deployments, fleets, jobReceipts, jobs } from "../src/lib/server/schema.ts";
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

describe("Cloudflare job ownership", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let service: ReturnType<typeof createCloudflareJobService>;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    (await initializeCloudflareFleet(environment.database.db)).unwrap();
    service = createCloudflareJobService(environment.database.db, storage);
  });
  beforeEach(async () => {
    await environment.database.db.delete(apps);
    await environment.database.db.delete(jobReceipts);
  });
  afterAll(async () => {
    await environment.close();
  });

  it("keeps one execution and a frozen snapshot across dispatch races and retries", async () => {
    const first = await seedDeployment(environment.database.db);
    const second = await seedDeployment(environment.database.db);
    const claims = await Promise.all(Array.from({ length: 5 }, () => service.next()));

    for (const claim of claims) expect(claim.unwrap()).toEqual({ id: first.jobId });
    await environment.database.db
      .update(apps)
      .set({ accessGroups: ["changed"], accessRevision: 2 })
      .where(eq(apps.id, first.appId));
    const recovered = (await service.deployment(first.jobId)).unwrap();
    expect(recovered?.access).toEqual({ groups: ["engineering"], revision: 1 });
    expect(recovered?.version).toBe(first.jobId);
    const [job] = await environment.database.db.select().from(jobs).where(eq(jobs.id, first.jobId));
    expect(job).toMatchObject({ agentId: null, leaseToken: null, leaseUntil: null, attempt: 1 });
    expect((await service.deployment(second.jobId)).isErr()).toBe(true);
  });

  it("shares completion rules and does not repeat activation for an acknowledged job", async () => {
    const first = await seedDeployment(environment.database.db);
    const second = await seedDeployment(environment.database.db);
    (await service.next()).unwrap();
    let activations = 0;
    const result = { outcome: "succeeded" as const, message: "Activated", accessRevision: 1 };

    const complete = () =>
      completeJob(
        environment.database.db,
        storage,
        { workflowId: first.jobId },
        first.jobId,
        result,
        undefined,
        async () => {
          activations++;
        },
      );

    (await complete()).unwrap();
    (await complete()).unwrap();
    expect(activations).toBe(1);
    expect((await service.next()).unwrap()).toEqual({ id: second.jobId });
    const [app] = await environment.database.db.select().from(apps).where(eq(apps.id, first.appId));
    expect(app).toMatchObject({
      activeDeploymentId: first.deploymentId,
      appliedAccessRevision: 1,
      state: "active",
    });
  });

  it("rolls back SQL completion if publishing fails and blocks the next deployment", async () => {
    const first = await seedDeployment(environment.database.db);
    await seedDeployment(environment.database.db);
    (await service.next()).unwrap();

    const result = await completeJob(
      environment.database.db,
      storage,
      { workflowId: first.jobId },
      first.jobId,
      { outcome: "succeeded", message: "Activated", accessRevision: 1 },
      undefined,
      async () => {
        throw new Error("R2 unavailable");
      },
    );

    expect(result.isErr()).toBe(true);
    expect((await service.next()).unwrap()).toEqual({ id: first.jobId });

    const [deployment] = await environment.database.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, first.deploymentId));

    expect(deployment?.status).toBe("running");
    expect(await environment.database.db.select().from(jobReceipts)).toHaveLength(0);
  });

  it("refuses failure after activation began and rejects a different workflow owner", async () => {
    const first = await seedDeployment(environment.database.db);
    (await service.next()).unwrap();
    await environment.database.db
      .update(jobs)
      .set({ activationStartedAt: new Date() })
      .where(eq(jobs.id, first.jobId));
    expect(
      await completeJob(
        environment.database.db,
        storage,
        { workflowId: first.jobId },
        first.jobId,
        { outcome: "failed", message: "Lost response" },
      ),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(
      await completeJob(
        environment.database.db,
        storage,
        { workflowId: crypto.randomUUID() },
        first.jobId,
        { outcome: "succeeded", message: "Wrong owner", accessRevision: 1 },
      ),
    ).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("prevents agents from claiming hosted jobs and refuses conversion of an occupied fleet", async () => {
    const first = await seedDeployment(environment.database.db);
    const agentId = crypto.randomUUID();
    await environment.database.db.insert(agents).values({
      id: agentId,
      fleetId: first.fleetId,
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
      .update(fleets)
      .set({ executor: "agent" })
      .where(eq(fleets.id, first.fleetId));
    expect(await initializeCloudflareFleet(environment.database.db)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect((await service.next()).unwrap()).toBeNull();
    await environment.database.db
      .update(fleets)
      .set({ executor: "cloudflare" })
      .where(eq(fleets.id, first.fleetId));
  });
});
