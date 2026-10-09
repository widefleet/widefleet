import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAppService, enqueueAppRemoval, managedApp } from "../src/lib/server/apps.ts";
import { createAppAccessService } from "../src/lib/server/app-access.ts";
import { apps, jobs } from "../src/lib/server/schema.ts";
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

    return { ...record, role: "member" as const, admin: false, creator: true };
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
      fleetId: parent.fleetId,
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
