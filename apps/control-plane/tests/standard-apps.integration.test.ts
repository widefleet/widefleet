import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as contract from "@platform/contracts";
import { createTestEnvironment } from "./environment.ts";
import { createStandardAppService } from "../src/lib/server/standard-apps.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createConnectionService } from "../src/lib/server/connections.ts";
import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";
import { apps, artifacts, deployments, organizationRuntimes } from "../src/lib/server/schema.ts";
import { member, organization } from "../src/lib/server/auth-schema.ts";
import type { Principal } from "../src/lib/server/identity.ts";
import type { OrganizationAccess } from "../src/lib/server/application-context.ts";

describe("standard app provisioning", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  const objects = new Map<string, Uint8Array>();
  let failUpload = false;

  const storage = createArtifactStorage({
    put: async (key, bytes) => {
      if (failUpload) throw new Error("Synthetic interrupted upload");
      objects.set(key, bytes);
    },
    get: async (key) => {
      const value = objects.get(key);

      if (!value) throw new Error("Object not found");

      return value;
    },
    exists: async (key) => objects.has(key),
    list: async function* (prefix) {
      for (const [key, value] of objects)
        if (key.startsWith(prefix)) yield { key, size: value.byteLength };
    },
    remove: async (keys) => {
      for (const key of keys) objects.delete(key);
    },
  });

  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => {
    await environment?.close();
  });

  const principal = async (): Promise<Principal> => {
    const id = crypto.randomUUID();
    await environment.database.db
      .insert(organization)
      .values({ id, slug: id, name: "Fixture organization", createdAt: new Date() });
    await environment.database.db
      .insert(organizationRuntimes)
      .values({ organizationId: id, appHostnameSuffix: `test-${id}` });
    await environment.database.db.insert(member).values({
      id: crypto.randomUUID(),
      userId: environment.ownerId,
      organizationId: id,
      role: "owner",
      createdAt: new Date(),
    });

    return {
      id: environment.ownerId,
      name: "Owner",
      email: "owner@example.test",
      role: "owner",
      admin: false,
      creator: true,
      application: { organizationId: id, admin: true },
    };
  };

  const service = () =>
    createStandardAppService(
      environment.database.db,
      environment.configuration,
      storage,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
    );

  const records = (owner: Principal) =>
    environment.database.db
      .select()
      .from(apps)
      .where(eq(apps.organizationId, owner.application.organizationId));

  it("creates three ordinary apps and one deployment each, including under concurrent retries", async () => {
    const owner = await principal();
    await Promise.all([service().ensure(owner), service().ensure(owner)]);
    const installed = await records(owner);
    expect(installed.map((app) => app.slug).sort()).toEqual(["github", "gmail", "onedrive"]);
    const secrets = installed.map((app) => app.secrets);
    expect(new Set(secrets.map((secret) => JSON.stringify(secret))).size).toBe(3);

    for (const app of installed) {
      const history = await environment.database.db
        .select()
        .from(deployments)
        .where(eq(deployments.appId, app.id));

      expect(history).toHaveLength(1);
      expect(app.catalogListed).toBe(true);
      expect(contract.networkPolicy.parse(app.networkPolicy).backend.length).toBeGreaterThan(0);

      const [artifact] = await environment.database.db
        .select()
        .from(artifacts)
        .where(eq(artifacts.appId, app.id));

      const metadata = contract.workerMetadata.parse(artifact?.metadata);
      expect(metadata.bindings).toEqual([{ type: "d1", name: "DB", database_name: "accounts" }]);
      expect(metadata.services?.["default"]?.methods.length).toBeGreaterThanOrEqual(4);
      await environment.database.db
        .update(apps)
        .set({ state: "active", activeDeploymentId: history[0]?.id })
        .where(eq(apps.id, app.id));
    }

    const entries = (
      await createConnectionService(environment.database.db).services(owner)
    ).unwrap();

    expect(entries).toHaveLength(3);
    expect(
      entries
        .find((entry) => entry.slug === "gmail")
        ?.services["default"]?.methods.map((method) => method.name),
    ).toContain("getAttachment");
    await service().ensure(owner);
    expect((await records(owner)).map((app) => app.secrets)).toEqual(secrets);
  });

  it("resumes interrupted provisioning without rotating its saved encryption secret", async () => {
    const owner = await principal();
    failUpload = true;
    await expect(service().ensure(owner)).rejects.toThrow();
    const before = await records(owner);
    expect(before).toHaveLength(1);
    failUpload = false;
    await service().ensure(owner);
    const after = await records(owner);
    expect(after).toHaveLength(3);
    expect(after.find((app) => app.id === before[0]?.id)?.secrets).toEqual(before[0]?.secrets);
  });

  it("preserves conflicting user apps and does not restore renamed or removed standard apps", async () => {
    const owner = await principal();

    const unrelated = (
      await createAppService(environment.database.db, environment.configuration).create(owner, {
        slug: "github",
        displayName: "User app",
        parentId: null,
      })
    ).unwrap();

    expect(
      (await service().ensure(owner)).some(
        (entry) => entry.slug === "github" && entry.status === "name_in_use",
      ),
    ).toBe(true);
    await environment.database.db
      .update(apps)
      .set({ slug: "my-mail", displayName: "My mail" })
      .where(
        and(eq(apps.organizationId, owner.application.organizationId), eq(apps.slug, "gmail")),
      );
    await environment.database.db
      .update(apps)
      .set({ removedAt: new Date(), state: "deleting" })
      .where(
        and(eq(apps.organizationId, owner.application.organizationId), eq(apps.slug, "onedrive")),
      );
    await service().ensure(owner);
    const installed = await records(owner);
    expect(installed).toHaveLength(3);
    expect(installed.find((app) => app.id === unrelated.id)?.displayName).toBe("User app");
    expect(installed.some((app) => app.slug === "gmail")).toBe(false);
    expect(installed.find((app) => app.slug === "onedrive")?.removedAt).not.toBeNull();
  });

  it("backfills admitted organizations in bounded batches and leaves excluded organizations alone", async () => {
    const first = await principal();
    const second = await principal();
    const excluded = await principal();
    const admitted = new Set([first.application.organizationId, second.application.organizationId]);

    const access = {
      filterOrganizations: async (candidates) =>
        candidates.flatMap(({ id }) => (admitted.has(id) ? [id] : [])),
    } satisfies OrganizationAccess;

    expect(await service().backfill(access, 1)).toHaveLength(1);
    expect((await records(first)).length + (await records(second)).length).toBe(3);
    expect(await service().backfill(access, 1)).toHaveLength(1);
    expect(await records(first)).toHaveLength(3);
    expect(await records(second)).toHaveLength(3);
    expect(await records(excluded)).toHaveLength(0);
    expect(await service().backfill(access, 1)).toHaveLength(0);
  });
});
