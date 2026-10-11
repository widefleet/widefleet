import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createAppService } from "../src/lib/server/apps.ts";
import { createAppAccessService } from "../src/lib/server/app-access.ts";
import { providerIssuer } from "../src/lib/server/company-identity.ts";
import { appRoleAssignments, apps, jobs } from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";

describe("App policy reconciliation", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  beforeEach(async () => {
    await environment.database.db.delete(apps);
  });
  afterAll(async () => {
    await environment.close();
  });

  const admin = () => ({
    ...environment.owner,
    admin: true,
    creator: true,
    role: "owner" as const,
    company: undefined,
  });

  const services = () => ({
    apps: createAppService(environment.database.db, environment.configuration),
    access: createAppAccessService(environment.database.db, environment.configuration),
  });

  it("skips confirmed unchanged targets while retrying failed previews", async () => {
    const service = services();

    const parent = (
      await service.apps.create(admin(), {
        slug: "unchanged",
        displayName: "Unchanged",
        parentId: null,
      })
    ).unwrap();

    const preview = (
      await service.apps.create(admin(), {
        slug: "unchanged-preview",
        displayName: "Preview",
        parentId: parent.id,
      })
    ).unwrap();

    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: crypto.randomUUID(), appliedAccessRevision: 1 });
    expect(
      (
        await service.access.change(admin(), parent.id, { revision: 1, allAuthenticated: false })
      ).unwrap().state,
    ).toBe("active");
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);
    await environment.database.db
      .update(apps)
      .set({ accessError: "Synthetic activation failure", appliedAccessRevision: null })
      .where(eq(apps.id, preview.id));

    const retried = (
      await service.access.change(admin(), parent.id, { revision: 1, allAuthenticated: false })
    ).unwrap();

    expect(retried.previews).toMatchObject([{ state: "pending", error: null, revision: 1 }]);
    expect(await environment.database.db.select({ appId: jobs.appId }).from(jobs)).toEqual([
      { appId: preview.id },
    ]);
  });

  it("reprojects a replacement issuer without reusing old grants or accepting stale writers", async () => {
    const directory = environment.configuration.PLATFORM_AUTH_DIRECTORY;
    await copyFile(join(directory, "desired.json"), join(directory, "active.json"));
    const service = services();

    const parent = (
      await service.apps.create(admin(), {
        slug: "replace",
        displayName: "Replace",
        parentId: null,
      })
    ).unwrap();

    const closed = (
      await service.apps.create(admin(), { slug: "closed", displayName: "Closed", parentId: null })
    ).unwrap();

    const issuer = providerIssuer(environment.configuration.IDENTITY.provider);

    for (const app of [parent, closed]) {
      (
        await service.access.grant(admin(), app.id, {
          revision: 1,
          role: "developer",
          principal: { type: "group", provider: issuer, subject: "engineering" },
        })
      ).unwrap();
    }

    (
      await service.access.change(admin(), parent.id, { revision: 2, allAuthenticated: true })
    ).unwrap();

    const preview = (
      await service.apps.create(admin(), {
        slug: "replace-preview",
        displayName: "Preview",
        parentId: parent.id,
      })
    ).unwrap();

    await environment.database.db.update(apps).set({ activeDeploymentId: crypto.randomUUID() });

    for (const [appId, revision] of [
      [parent.id, 3],
      [preview.id, 3],
      [closed.id, 2],
    ] as const)
      await environment.database.db
        .update(apps)
        .set({ appliedAccessRevision: revision })
        .where(eq(apps.id, appId));
    const previous = await environment.database.db.select().from(appRoleAssignments);
    const previousApps = await environment.database.db.select().from(apps).orderBy(apps.id);
    const settings = (await environment.settings.read(admin())).settings;

    if (!settings.identity) throw new Error("Missing identity");
    await environment.settings.update(
      admin(),
      {
        ...settings,
        identity: {
          ...settings.identity,
          provider: {
            type: "oidc",
            issuer: "https://replacement.example.test",
            label: "Replacement",
            subjectClaim: "sub",
            groupsClaim: "groups",
            nameClaim: "name",
            emailClaim: "email",
          },
        },
        acknowledgeRestart: true,
      },
      false,
    );
    const replacement = await environment.settings.resolve();
    await writeFile(
      join(directory, "status.json"),
      JSON.stringify({
        revision: replacement.revision,
        state: "failed",
        message: "Synthetic startup failure",
      }),
    );
    expect((await environment.settings.read(admin())).activation.state).toBe("failed");
    expect(await environment.database.db.select().from(apps).orderBy(apps.id)).toEqual(
      previousApps,
    );
    expect(await environment.database.db.select().from(jobs)).toHaveLength(0);

    if (!replacement.identity) throw new Error("Missing replacement identity");

    const replacementConfiguration = {
      ...environment.configuration,
      IDENTITY: replacement.identity,
    };

    expect(
      await createAppAccessService(environment.database.db, replacementConfiguration).change(
        admin(),
        parent.id,
        { revision: 3, allAuthenticated: false },
      ),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(
      await createAppService(environment.database.db, replacementConfiguration).create(admin(), {
        slug: "not-active",
        displayName: "Not active",
        parentId: null,
      }),
    ).toMatchObject({ error: { code: "CONFLICT" } });

    // Only a successful supervisor start publishes active.json. Regular runtime
    // resolution (including agent polling) then reconciles the affected policies.
    await copyFile(join(directory, "desired.json"), join(directory, "active.json"));
    await environment.settings.resolve();
    await environment.settings.resolve();
    const changed = (await service.access.read(admin(), parent.id)).unwrap();
    expect(changed).toMatchObject({
      provider: "https://replacement.example.test",
      groups: [],
      users: [],
      allAuthenticated: true,
      revision: 4,
      appliedRevision: 3,
      state: "pending",
    });
    expect(changed.previews).toMatchObject([
      {
        appId: preview.id,
        provider: changed.provider,
        groups: [],
        users: [],
        allAuthenticated: true,
        revision: 4,
        state: "pending",
      },
    ]);
    expect((await service.access.read(admin(), closed.id)).unwrap()).toMatchObject({
      provider: changed.provider,
      groups: [],
      users: [],
      allAuthenticated: false,
      revision: 3,
      state: "pending",
    });
    expect(await environment.database.db.select().from(appRoleAssignments)).toEqual(previous);
    expect(
      (await environment.database.db.select({ appId: jobs.appId }).from(jobs))
        .map(({ appId }) => appId ?? "")
        .sort(),
    ).toEqual([parent.id, preview.id, closed.id].sort());
    expect(
      await service.access.change(admin(), parent.id, { revision: 4, allAuthenticated: false }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(
      await service.apps.create(admin(), { slug: "stale", displayName: "Stale", parentId: null }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
  });
});
