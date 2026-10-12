import * as contract from "@platform/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { createAppService } from "../src/lib/server/apps.ts";
import { connectorReference, createConnectorService } from "../src/lib/server/connectors.ts";
import { apps, artifacts, connectors, deployments, jobs } from "../src/lib/server/schema.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createTestEnvironment } from "./environment.ts";

describe("Connector discovery and app connections", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let service: ReturnType<typeof createConnectorService>;
  let appService: ReturnType<typeof createAppService>;
  let creator: Awaited<ReturnType<typeof person>>;
  let colleague: Awaited<ReturnType<typeof person>>;
  let app: z.infer<typeof contract.app>;

  const person = async (name: string) => {
    const record = environment.users.createUser({ name, email: `${name}@example.test` });
    await environment.users.saveUser(record);
    await environment.linkMicrosoftUser(record.id);

    return { ...record, role: "member" as const, admin: false, creator: true };
  };

  beforeAll(async () => {
    environment = await createTestEnvironment();
    service = createConnectorService(
      environment.database.db,
      createStorage(environment.configuration),
      "local-test-only",
    );
    appService = createAppService(environment.database.db, environment.configuration);
    creator = await person("connection-creator");
    colleague = await person("connection-reader");
  });

  beforeEach(async () => {
    await environment.database.db.delete(connectors);
    await environment.database.db.delete(apps);
    await environment.database.db.delete(jobs);
    app = (
      await appService.create(creator, {
        slug: "inventory",
        displayName: "Inventory",
        parentId: null,
      })
    ).unwrap();
  });

  afterAll(async () => {
    await environment.close();
  });

  const deploy = async (
    bindings: z.infer<typeof contract.workerMetadata>["bindings"],
    active = true,
  ) => {
    const artifactId = crypto.randomUUID();
    const deploymentId = crypto.randomUUID();
    await environment.database.db.insert(artifacts).values({
      id: artifactId,
      appId: app.id,
      manifest: {},
      modules: [],
      metadata: contract.workerMetadata.parse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        bindings,
        assets: { upload_session: crypto.randomUUID(), binding: "ASSETS" },
      }),
    });
    await environment.database.db.insert(deployments).values({
      id: deploymentId,
      appId: app.id,
      artifactId,
      requestId: crypto.randomUUID(),
      status: active ? "succeeded" : "failed",
    });

    if (active)
      await environment.database.db
        .update(apps)
        .set({ activeDeploymentId: deploymentId, state: "active", appliedCapabilityRevision: 0 })
        .where(eq(apps.id, app.id));

    return deploymentId;
  };

  it("offers only grantable entrypoints without exposing administrative metadata", async () => {
    const reference = connectorReference.parse({
      name: "erp",
      checksum: "a".repeat(64),
      entrypoints: ["default", "NewReader"],
      classes: [],
      secrets: { API_KEY: "synthetic-ciphertext" },
      secretRevision: 9,
    });

    await environment.database.db.insert(connectors).values([
      {
        name: "erp",
        fleetId: app.fleetId,
        jobId: crypto.randomUUID(),
        package: reference,
        appliedPackage: { ...reference, entrypoints: ["default", "OldReader"] },
      },
      {
        name: "pending",
        fleetId: app.fleetId,
        jobId: crypto.randomUUID(),
        package: { ...reference, name: "pending" },
      },
    ]);

    expect((await service.catalog()).unwrap()).toEqual([
      { name: "erp", entrypoints: ["default"] },
      { name: "pending", entrypoints: [] },
    ]);
    expect(await service.list(creator)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.read(creator, "erp")).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(
      await service.bind(creator, app.id, "ERP", { connector: "erp", entrypoint: "default" }),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("authorizes app collaborators and distinguishes saved grants from active connections", async () => {
    await environment.database.db
      .update(apps)
      .set({
        capabilities: { ERP: { connector: "erp", entrypoint: "default" } },
        capabilityRevision: 1,
      })
      .where(eq(apps.id, app.id));
    expect((await service.connections(creator, app.id)).unwrap()).toEqual({
      deploymentId: null,
      resources: [],
      activeConnectors: {},
      connectors: {
        revision: 1,
        appliedRevision: null,
        grants: { ERP: { connector: "erp", entrypoint: "default" } },
        state: "saved",
        error: null,
      },
    });
    expect(await service.connections(colleague, app.id)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    (await appService.grant(creator, app.id, colleague.id)).unwrap();
    expect((await service.connections(colleague, app.id)).unwrap().connectors.state).toBe("saved");
  });

  it("reads resource names only from the serving deployment and omits variable values", async () => {
    const active = await deploy([
      { type: "d1", name: "DB", database_name: "inventory" },
      { type: "r2_bucket", name: "FILES", bucket_name: "uploads" },
      { type: "kv_namespace", name: "CACHE", id: "inventory-cache" },
      { type: "queue", name: "EVENTS", queue: "events" },
      { type: "workflow", name: "SYNC", workflow_name: "sync", class_name: "Sync" },
      { type: "plain_text", name: "PRIVATE_VALUE", text: "synthetic-sensitive-value" },
    ]);

    await deploy([{ type: "d1", name: "NEW_DB", database_name: "not-serving" }], false);
    const result = (await service.connections(creator, app.id)).unwrap();
    expect(result.deploymentId).toBe(active);
    expect(result.resources).toEqual([
      { binding: "DB", type: "d1", target: "inventory" },
      { binding: "FILES", type: "r2_bucket", target: "uploads" },
      { binding: "CACHE", type: "kv_namespace", target: "inventory-cache" },
      { binding: "EVENTS", type: "queue", target: "events" },
      { binding: "SYNC", type: "workflow", target: "sync" },
      { binding: "ASSETS", type: "assets", target: "inventory" },
    ]);
    expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-value");
    expect(result.activeConnectors).toEqual({});
  });

  it.each([null, "Synthetic activation failure"])(
    "preserves serving bindings across pending or failed removal: %s",
    async (error) => {
      const deploymentId = await deploy([]);
      const active = { ERP: { connector: "erp", entrypoint: "default" } };
      await environment.database.db.insert(jobs).values([
        {
          id: crypto.randomUUID(),
          appId: app.id,
          fleetId: app.fleetId,
          deploymentId,
          kind: "deploy",
          state: "succeeded",
          capabilities: { revision: 1, grants: active },
        },
        {
          id: crypto.randomUUID(),
          appId: app.id,
          fleetId: app.fleetId,
          deploymentId,
          kind: "configure",
          state: "failed",
          capabilities: { revision: 2, grants: {} },
        },
        {
          id: crypto.randomUUID(),
          appId: app.id,
          fleetId: app.fleetId,
          kind: "configure",
          state: "succeeded",
          capabilities: { revision: 2, grants: {} },
        },
      ]);
      await environment.database.db
        .update(apps)
        .set({
          capabilities: {},
          capabilityRevision: 2,
          appliedCapabilityRevision: 1,
          capabilityError: error,
        })
        .where(eq(apps.id, app.id));
      const result = (await service.connections(creator, app.id)).unwrap();
      expect(result.activeConnectors).toEqual(active);
      expect(result.connectors).toMatchObject({
        grants: {},
        state: error ? "failed" : "pending",
        error,
      });

      await environment.database.db
        .update(apps)
        .set({ appliedCapabilityRevision: 2, capabilityError: null })
        .where(eq(apps.id, app.id));
      expect((await service.connections(creator, app.id)).unwrap()).toMatchObject({
        activeConnectors: {},
        connectors: { state: "active" },
      });
    },
  );

  it("does not present desired bindings as active when the serving snapshot is unavailable", async () => {
    await deploy([]);
    await environment.database.db
      .update(apps)
      .set({
        capabilities: { ERP: { connector: "erp", entrypoint: "default" } },
        capabilityRevision: 2,
        appliedCapabilityRevision: 1,
      })
      .where(eq(apps.id, app.id));
    expect((await service.connections(creator, app.id)).unwrap().activeConnectors).toBeNull();
  });
});
