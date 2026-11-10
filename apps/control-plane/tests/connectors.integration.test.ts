import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as contract from "@platform/contracts";
import { createTestEnvironment } from "./environment.ts";
import { initializeRuntime } from "../src/lib/server/runtime-initialization.ts";
import { createTestEnvironment as createArtifactEnvironment } from "./artifact-environment.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnectorApps } from "../src/lib/server/connector-apps.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createConnectionService } from "../src/lib/server/connections.ts";
import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";
import {
  apps,
  artifacts,
  deployments,
  organizationRuntimes,
  installation,
} from "../src/lib/server/schema.ts";
import { member, organization } from "../src/lib/server/auth-schema.ts";
import type { Principal } from "../src/lib/server/identity.ts";

describe("connector provisioning", () => {
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
    createConnectorApps(
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

  it("provisions a new self-hosted installation once and preserves a later removal on restart", async () => {
    const fresh = await createArtifactEnvironment();

    try {
      await fresh.database.db.update(installation).set({ ownerId: null });

      const bootstrap = join(
        fresh.configuration.PLATFORM_STATE_DIRECTORY,
        "connector-bootstrap.json",
      );

      await writeFile(
        bootstrap,
        JSON.stringify({ owner: { name: "New owner", email: "connector-owner@example.test" } }),
      );
      const configuration = { ...fresh.configuration, PLATFORM_BOOTSTRAP_FILE: bootstrap };
      const initialized = await initializeRuntime(configuration, "apps/control-plane/migrations");

      try {
        const installed = await fresh.database.db.select().from(apps);
        expect(installed.map((app) => app.slug).sort()).toEqual(["github", "gmail", "onedrive"]);
        await fresh.database.db
          .update(apps)
          .set({ removedAt: new Date(), state: "deleting" })
          .where(eq(apps.slug, "gmail"));
      } finally {
        await initialized.observation.close();
        await initialized.database.close();
      }

      const restarted = await initializeRuntime(configuration, "apps/control-plane/migrations");

      try {
        const installed = await fresh.database.db.select().from(apps);
        expect(installed).toHaveLength(3);
        expect(installed.find((app) => app.slug === "gmail")?.removedAt).not.toBeNull();
        expect(await fresh.database.db.select().from(deployments)).toHaveLength(3);
      } finally {
        await restarted.observation.close();
        await restarted.database.close();
      }
    } finally {
      await fresh.close();
    }
  });

  it("leaves existing organizations unchanged when the control plane starts", async () => {
    const owner = await principal();

    const runtime = await initializeRuntime(
      environment.configuration,
      "apps/control-plane/migrations",
    );

    try {
      expect(await records(owner)).toEqual([]);
      expect(
        await environment.database.db
          .select()
          .from(apps)
          .where(eq(apps.organizationId, "widefleet")),
      ).toEqual([]);
    } finally {
      await runtime.observation.close();
      await runtime.database.close();
    }
  });

  it("creates three ordinary apps and one deployment each, including under concurrent retries", async () => {
    const owner = await principal();
    await Promise.all([
      service().organization(owner.id, owner.application.organizationId),
      service().organization(owner.id, owner.application.organizationId),
    ]);
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
      expect(metadata.entrypoints).toEqual(["default"]);
      await environment.database.db
        .update(apps)
        .set({ state: "active", activeDeploymentId: history[0]?.id })
        .where(eq(apps.id, app.id));
    }

    const entries = (
      await createConnectionService(environment.database.db).services(owner)
    ).unwrap();

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.slug).sort()).toEqual(["github", "gmail", "onedrive"]);
    await service().organization(owner.id, owner.application.organizationId);
    expect((await records(owner)).map((app) => app.secrets)).toEqual(secrets);
  });

  it("resumes interrupted provisioning without rotating its saved encryption secret", async () => {
    const owner = await principal();
    failUpload = true;
    await expect(
      service().organization(owner.id, owner.application.organizationId),
    ).rejects.toThrow();
    const before = await records(owner);
    expect(before).toHaveLength(1);
    failUpload = false;
    await service().organization(owner.id, owner.application.organizationId);
    const after = await records(owner);
    expect(after).toHaveLength(3);
    expect(after.find((app) => app.id === before[0]?.id)?.secrets).toEqual(before[0]?.secrets);
  });

  it("preserves conflicting user apps and does not restore renamed or removed connectors", async () => {
    const owner = await principal();

    const unrelated = (
      await createAppService(environment.database.db, environment.configuration).create(owner, {
        slug: "github",
        displayName: "User app",
        parentId: null,
      })
    ).unwrap();

    expect(
      (await service().organization(owner.id, owner.application.organizationId)).some(
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
    await service().organization(owner.id, owner.application.organizationId);
    const installed = await records(owner);
    expect(installed).toHaveLength(3);
    expect(installed.find((app) => app.id === unrelated.id)?.displayName).toBe("User app");
    expect(installed.some((app) => app.slug === "gmail")).toBe(false);
    expect(installed.find((app) => app.slug === "onedrive")?.removedAt).not.toBeNull();
  });
});
