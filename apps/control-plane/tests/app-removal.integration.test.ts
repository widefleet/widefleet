import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAppService, enqueueAppRemoval, managedApp } from "../src/lib/server/apps.ts";
import { createAppAccessService } from "../src/lib/server/app-access.ts";
import { finishAppRemoval } from "../src/lib/server/app-removal.ts";
import {
  apps,
  jobs,
  appGrants,
  uploadSessions,
  artifacts,
  deployments,
  deploymentEvents,
  cloudflareOperations,
} from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";

describe("App removal trees", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let service: ReturnType<typeof createAppService>;
  let creator: Awaited<ReturnType<typeof person>>;
  let colleague: Awaited<ReturnType<typeof person>>;

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
    creator = await person("creator");
    colleague = await person("colleague");
  });

  beforeEach(async () => {
    await environment.database.db.delete(apps);
  });

  afterAll(async () => {
    await environment.close();
  });

  const create = async (slug: string, parentId: string | null = null, principal = creator) =>
    (await service.create(principal, { slug, displayName: slug, parentId })).unwrap();

  const legacyPreview = async (slug: string, parentId: string) => {
    const app = await create(slug);
    await environment.database.db.update(apps).set({ parentId }).where(eq(apps.id, app.id));

    return { ...app, parentId };
  };

  it("retains removed identity, clears dependent data and allows a fresh app to reuse the name", async () => {
    const app = await create("reusable");
    (await service.grant(creator, app.id, colleague.id)).unwrap();
    const artifactId = crypto.randomUUID();
    const deploymentId = crypto.randomUUID();
    const db = environment.database.db;
    await db.insert(uploadSessions).values({
      id: crypto.randomUUID(),
      appId: app.id,
      userId: creator.id,
      manifest: {},
      expiresAt: new Date(),
    });
    await db
      .insert(artifacts)
      .values({ id: artifactId, appId: app.id, metadata: {}, manifest: {}, modules: [] });
    await db
      .insert(deployments)
      .values({ id: deploymentId, appId: app.id, artifactId, requestId: "removed" });
    await db
      .insert(deploymentEvents)
      .values({ deploymentId, level: "info", message: "Removed fixture" });
    await db.insert(jobs).values({
      id: crypto.randomUUID(),
      appId: app.id,
      organizationId: app.organizationId,
      deploymentId,
      kind: "deploy",
    });
    await db.insert(cloudflareOperations).values({
      id: crypto.randomUUID(),
      appId: app.id,
      command: {},
      targets: [],
      result: {},
      createdAt: new Date(),
    });
    await db.update(apps).set({ activeDeploymentId: deploymentId }).where(eq(apps.id, app.id));
    (await service.remove(creator, app.id)).unwrap();
    await db.transaction(async (transaction) => {
      (await managedApp(transaction, creator, app.id)).unwrap();
      await finishAppRemoval(transaction, app.id);
    });

    expect(await db.select().from(apps)).toEqual([
      expect.objectContaining({
        id: app.id,
        organizationId: app.organizationId,
        activeDeploymentId: null,
      }),
    ]);
    expect((await db.select().from(apps))[0]?.removedAt).toBeInstanceOf(Date);
    expect(await db.select().from(appGrants)).toEqual([]);
    expect(await db.select().from(uploadSessions)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
    expect(await db.select().from(cloudflareOperations)).toEqual([]);
    expect(await db.select().from(deployments)).toEqual([]);
    expect(await db.select().from(deploymentEvents)).toEqual([]);
    expect(await db.select().from(artifacts)).toEqual([]);

    for (const principal of [
      creator,
      colleague,
      { ...creator, application: { ...creator.application, admin: true } },
    ]) {
      expect((await service.list(principal)).unwrap()).toEqual([]);
      expect(await service.get(principal, app.id)).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(await service.grant(principal, app.id, colleague.id)).toMatchObject({
        error: { code: "NOT_FOUND" },
      });
    }

    expect(
      await service.create(creator, { slug: "preview", displayName: "Preview", parentId: app.id }),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    const replacement = (await service.resolve(creator, app.slug)).unwrap();
    expect(replacement.id).not.toBe(app.id);
    expect(replacement.hostname).toBe(app.hostname);
    expect(
      await service.create(creator, { slug: app.slug, displayName: "Duplicate", parentId: null }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect((await service.resolve(creator, app.slug)).unwrap().id).toBe(replacement.id);
  });

  it("does not enqueue a removed preview again when removing its parent", async () => {
    const parent = await create("parent");
    const preview = await create("preview", parent.id);
    (await service.remove(creator, preview.id)).unwrap();
    await environment.database.db.transaction(async (transaction) => {
      (await managedApp(transaction, creator, preview.id)).unwrap();
      await finishAppRemoval(transaction, preview.id);
    });
    (await service.remove(creator, parent.id)).unwrap();
    expect((await environment.database.db.select().from(jobs)).map((job) => job.appId)).toEqual([
      parent.id,
    ]);
  });

  it("authorizes the root and includes previews owned by collaborators", async () => {
    const parent = await create("parent");
    expect(await service.remove(colleague, parent.id)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    (await service.grant(creator, parent.id, colleague.id)).unwrap();
    const preview = await create("preview", parent.id, colleague);
    expect(await service.get(creator, preview.id)).toMatchObject({ error: { code: "NOT_FOUND" } });
    const unrelated = await create("unrelated");

    (await service.remove(creator, parent.id)).unwrap();
    expect((await service.get(colleague, preview.id)).unwrap()).toMatchObject({
      state: "deleting",
      parentId: parent.id,
    });
    expect((await service.get(creator, unrelated.id)).unwrap().state).toBe("created");
    expect(
      await service.create(colleague, {
        slug: "too-late",
        displayName: "Too Late",
        parentId: preview.id,
      }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(
      (await environment.database.db.select().from(jobs).orderBy(jobs.sequence)).map(
        (job) => job.appId,
      ),
    ).toEqual([preview.id, parent.id]);
  });

  it("removes a preview subtree without deleting its parent or siblings", async () => {
    const parent = await create("parent");
    const preview = await create("preview", parent.id);
    const nested = await legacyPreview("nested", preview.id);
    const sibling = await create("sibling", parent.id);
    (await service.remove(creator, preview.id)).unwrap();
    (await service.remove(creator, preview.id)).unwrap();
    expect(
      (await environment.database.db.select().from(jobs).orderBy(jobs.sequence)).map(
        (job) => job.appId,
      ),
    ).toEqual([nested.id, preview.id]);
    expect((await service.get(creator, parent.id)).unwrap().state).toBe("created");
    expect((await service.get(creator, sibling.id)).unwrap().state).toBe("created");
  });

  it("serializes overlapping removal and creation without leaving live descendants or duplicate jobs", async () => {
    const parent = await create("parent");
    const preview = await create("preview", parent.id);
    await legacyPreview("nested", preview.id);

    const [parentRemoval, previewRemoval, creation] = await Promise.all([
      service.remove(creator, parent.id),
      service.remove(creator, preview.id),
      service.create(creator, { slug: "racing", displayName: "Racing", parentId: parent.id }),
    ]);

    parentRemoval.unwrap();
    previewRemoval.unwrap();

    if (creation.isErr()) expect(creation.error).toMatchObject({ code: "CONFLICT" });
    const records = await environment.database.db.select().from(apps);
    expect(records.every((record) => record.state === "deleting")).toBe(true);
    const queued = await environment.database.db.select().from(jobs);
    expect(queued).toHaveLength(records.length);
    expect(new Set(queued.map((job) => job.appId))).toEqual(
      new Set(records.map((record) => record.id)),
    );
  });

  it("discovers descendants even when a deletion was already queued", async () => {
    const parent = await create("parent");
    const preview = await create("preview", parent.id);
    await environment.database.db
      .update(apps)
      .set({ state: "deleting" })
      .where(eq(apps.id, parent.id));
    await environment.database.db.insert(jobs).values({
      id: crypto.randomUUID(),
      appId: parent.id,
      organizationId: parent.organizationId,
      kind: "delete",
    });
    (await service.remove(creator, parent.id)).unwrap();
    (await service.remove(creator, parent.id)).unwrap();
    expect((await service.get(creator, preview.id)).unwrap().state).toBe("deleting");
    expect(await environment.database.db.select().from(jobs)).toHaveLength(2);
  });

  it("serializes access inheritance with removal of a legacy preview subtree", async () => {
    const parent = await create("parent");
    const nested = await create("nested");
    const preview = await create("preview", parent.id);
    const sibling = await create("sibling", parent.id);
    await environment.database.db
      .update(apps)
      .set({ parentId: preview.id })
      .where(eq(apps.id, nested.id));
    // Put the nested row before its parent in heap order. An unordered bulk UPDATE
    // can otherwise lock the nested row before waiting for the preview's removal.
    await environment.database.db
      .update(apps)
      .set({ displayName: "Preview" })
      .where(eq(apps.id, preview.id));
    const access = createAppAccessService(environment.database.db);
    let change: ReturnType<typeof access.change> | undefined;

    await environment.database.db.transaction(async (transaction) => {
      const record = (await managedApp(transaction, creator, preview.id)).unwrap();

      const backend = await transaction.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      );

      const pid = backend.rows[0]?.pid;

      if (!pid) throw new Error("Missing transaction backend");

      change = access.change(creator, parent.id, { revision: 0, groups: ["engineering"] });
      await expect
        .poll(async () => {
          const waiting = await environment.database.db.execute<{ blocked: boolean }>(sql`
          select exists (
            select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
          ) as blocked
        `);

          return waiting.rows[0]?.blocked;
        })
        .toBe(true);
      await enqueueAppRemoval(transaction, record);
    });

    if (!change) throw new Error("Access update was not started");
    (await change).unwrap();
    const records = await environment.database.db.select().from(apps);
    expect(
      records
        .filter((app) => app.state === "deleting")
        .map((app) => app.id)
        .sort(),
    ).toEqual([preview.id, nested.id].sort());
    expect(records.filter((app) => app.state !== "deleting")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: parent.id,
          accessGroups: ["engineering"],
          accessRevision: 1,
        }),
        expect.objectContaining({
          id: sibling.id,
          accessGroups: ["engineering"],
          accessRevision: 1,
        }),
      ]),
    );
  });
});
