import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAppService } from "../src/lib/server/apps.ts";
import { apps, memberGroups } from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";

describe("App catalog", () => {
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

  const admin = () => ({
    ...environment.owner,
    application: { ...environment.application, admin: true },
    role: "owner" as const,
    admin: true,
    creator: true,
  });

  beforeAll(async () => {
    environment = await createTestEnvironment();
    service = createAppService(environment.database.db, {
      ...environment.configuration,
      APP_HTTPS_PORT: 25453,
    });
    creator = await person("creator");
    colleague = await person("colleague");
  });

  beforeEach(async () => {
    await environment.database.db.delete(apps);
  });

  afterAll(async () => {
    await environment.close();
  });

  const createApp = async (slug: string) =>
    (await service.create(creator, { slug, displayName: slug, parentId: null })).unwrap();

  const activate = async (appId: string) => {
    const activeDeploymentId = crypto.randomUUID();
    await environment.database.db
      .update(apps)
      .set({ state: "active", activeDeploymentId })
      .where(eq(apps.id, appId));

    return activeDeploymentId;
  };

  it("requires explicit listing and exposes only launch information without management access", async () => {
    const app = await createApp("team-notes");
    expect(app.catalogListed).toBe(false);
    const activeDeploymentId = await activate(app.id);
    expect((await service.catalog(colleague)).unwrap()).toEqual([]);

    (await service.setCatalogListing(creator, app.id, true)).unwrap();
    expect((await service.catalog(colleague)).unwrap()).toEqual([
      {
        id: app.id,
        displayName: "team-notes",
        description: null,
        hostname: "team-notes.apps.localhost",
        url: "https://team-notes.apps.localhost:25453/",
        activeDeploymentId,
        connector: false,
        uses: [],
      },
    ]);
    expect((await service.list(colleague)).unwrap()).toEqual([]);
    expect(await service.get(colleague, app.id)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await service.history(colleague, app.id)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(await service.remove(colleague, app.id)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await service.setCatalogListing(colleague, app.id, false)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    (await service.setCatalogListing(creator, app.id, false)).unwrap();
    expect((await service.catalog(colleague)).unwrap()).toEqual([]);
  });

  it("lets administrators change listings but rejects ordinary app collaborators", async () => {
    const app = await createApp("shared-app");
    await activate(app.id);
    (await service.grant(creator, app.id, colleague.id)).unwrap();
    expect(await service.setCatalogListing(colleague, app.id, true)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect((await service.catalog(colleague)).unwrap()).toEqual([]);

    (await service.setCatalogListing(admin(), app.id, true)).unwrap();
    expect(await service.setCatalogListing(colleague, app.id, false)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect((await service.catalog(colleague)).unwrap()).toHaveLength(1);
    (await service.setCatalogListing(admin(), app.id, false)).unwrap();
    expect((await service.catalog(colleague)).unwrap()).toEqual([]);
  });

  it.each([
    { state: "created", deployed: false, preview: false },
    { state: "active", deployed: false, preview: false },
    { state: "active", deployed: true, preview: true },
    { state: "deleting", deployed: true, preview: false },
  ] as const)("excludes ineligible apps: %j", async ({ state, deployed, preview }) => {
    const app = await createApp("ineligible");
    await environment.database.db
      .update(apps)
      .set({
        state,
        activeDeploymentId: deployed ? crypto.randomUUID() : null,
        parentId: preview ? crypto.randomUUID() : null,
      })
      .where(eq(apps.id, app.id));

    expect(await service.setCatalogListing(creator, app.id, true)).toMatchObject({
      error: { code: "CONFLICT" },
    });

    // A previously enabled listing must not override the current runtime state.
    await environment.database.db
      .update(apps)
      .set({ catalogListed: true })
      .where(eq(apps.id, app.id));
    expect((await service.catalog(colleague)).unwrap()).toEqual([]);
    (await service.setCatalogListing(creator, app.id, false)).unwrap();
  });

  it("keeps listing through version changes, starts previews unlisted and hides deletion requests", async () => {
    const app = await createApp("published-app");
    await activate(app.id);
    (await service.setCatalogListing(creator, app.id, true)).unwrap();
    await activate(app.id);
    expect((await service.catalog(colleague)).unwrap()).toHaveLength(1);

    const preview = (
      await service.create(creator, {
        slug: "published-preview",
        displayName: "Published Preview",
        parentId: app.id,
      })
    ).unwrap();

    expect(preview.catalogListed).toBe(false);
    await activate(preview.id);
    expect((await service.catalog(colleague)).unwrap()).toHaveLength(1);

    (await service.remove(creator, app.id)).unwrap();
    expect((await service.catalog(colleague)).unwrap()).toEqual([]);
  });
  it("shows a published app with group rules to the people who can open it", async () => {
    const app = await createApp("payroll");
    await activate(app.id);
    (await service.setCatalogListing(creator, app.id, true)).unwrap();
    await environment.database.db
      .update(apps)
      .set({ accessGroups: ["finance"] })
      .where(eq(apps.id, app.id));

    const listed = async (principal: Parameters<typeof service.catalog>[0]) =>
      (await service.catalog(principal)).unwrap().map((entry) => entry.id);

    // What a company sign-in leaves: the groups the member had then.
    const signedIn = (userId: string, groups: string[]) =>
      environment.database.db
        .insert(memberGroups)
        .values({ userId, organizationId: environment.application.organizationId, groups })
        .onConflictDoUpdate({
          target: [memberGroups.userId, memberGroups.organizationId],
          set: { groups },
        });

    try {
      // Without a company sign-in the groups are unknown, and the app stays listed.
      expect(await listed(colleague)).toEqual([app.id]);

      await signedIn(colleague.id, ["sales"]);
      expect(await listed(colleague)).toEqual([]);
      expect(await service.listing(colleague, app.id)).toMatchObject({
        error: { code: "NOT_FOUND" },
      });

      await signedIn(colleague.id, ["sales", "finance"]);
      expect(await listed(colleague)).toEqual([app.id]);
      expect((await service.listing(colleague, app.id)).isOk()).toBe(true);

      // The people who manage the app see it whatever its rules say.
      await signedIn(creator.id, ["sales"]);
      expect(await listed(creator)).toEqual([app.id]);
      expect(await listed(admin())).toEqual([app.id]);

      // An app without group rules is listed for everyone.
      await signedIn(colleague.id, []);
      expect(await listed(colleague)).toEqual([]);
      await environment.database.db
        .update(apps)
        .set({ accessGroups: [] })
        .where(eq(apps.id, app.id));
      expect(await listed(colleague)).toEqual([app.id]);
    } finally {
      await environment.database.db.delete(memberGroups);
    }
  });
});
