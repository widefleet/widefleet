import { jobs } from "../src/lib/server/schema.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as contract from "@platform/contracts";
import type { z } from "zod";
import { createTestEnvironment } from "./environment.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import {
  encodeDocumentation,
  storeDocumentation,
} from "../src/lib/server/artifact-documentation.ts";
import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";
import { createConnectionService } from "../src/lib/server/connections.ts";
import { createAppSecrets } from "../src/lib/server/app-secrets.ts";
import { apps, artifacts, deployments } from "../src/lib/server/schema.ts";
import { decryptSecret } from "../src/lib/server/secret-encryption.ts";
import type { Principal } from "../src/lib/server/identity.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";

describe("App service connections", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let principal: Principal;
  beforeAll(async () => {
    environment = await createTestEnvironment();
    principal = {
      id: environment.ownerId,
      name: "Owner",
      email: "owner@example.test",
      role: "owner",
      admin: true,
      creator: true,
      application: { organizationId: "widefleet", admin: true },
    };
  });
  afterAll(async () => {
    await environment.close();
  });

  const storage = createArtifactStorage(memoryStorage());

  const services = () => createConnectionService(environment.database.db, storage);

  // Publishing keeps documentation in artifact storage and a summary in the database.
  const documented = async (
    appId: string,
    artifactId: string,
    documentation: z.input<typeof contract.serviceDocumentation>,
  ) => {
    const encoded = encodeDocumentation(contract.serviceDocumentation.parse(documentation));
    (await storeDocumentation(storage, appId, artifactId, encoded)).unwrap();

    return encoded.summary;
  };

  const applications = () => createAppService(environment.database.db, environment.configuration);

  const secrets = () =>
    createAppSecrets(environment.database.db, environment.environment.PLATFORM_ENCRYPTION_KEY);

  const app = async (
    entrypoints: string[] = [],
    actor = principal,
    documentation?: z.input<typeof contract.serviceDocumentation>,
  ) => {
    const app = (
      await applications().create(actor, {
        slug: `app-${crypto.randomUUID()}`,
        displayName: "Service fixture",
        parentId: null,
      })
    ).unwrap();

    const artifactId = crypto.randomUUID();
    const deploymentId = crypto.randomUUID();

    const metadata = contract.workerMetadata.parse({
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      web: false,
      entrypoints,
      assets: { upload_session: artifactId, binding: "ASSETS" },
    });

    await environment.database.db.insert(artifacts).values({
      id: artifactId,
      appId: app.id,
      metadata,
      manifest: {},
      modules: [{ name: "worker.js", type: "esm", size: 1, sha256: "a".repeat(64) }],
      documentation: documentation ? await documented(app.id, artifactId, documentation) : null,
    });
    await environment.database.db.insert(deployments).values({
      id: deploymentId,
      appId: app.id,
      artifactId,
      status: "succeeded",
      requestId: crypto.randomUUID(),
    });
    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: deploymentId, state: "active" })
      .where(eq(apps.id, app.id));

    return { ...app, artifactId };
  };

  it("lists default handlers as app APIs only with RPC methods or documentation", async () => {
    const entry = (name: string, methods: string[], summary = "") => ({
      name,
      summary,
      remarks: "",
      examples: [],
      http: true,
      methods: methods.map((method) => ({
        name: method,
        summary: "",
        remarks: "",
        examples: [],
        throws: [],
        signatures: [{ parameters: [], returns: { type: "Promise<void>", description: "" } }],
      })),
    });

    const documented = (...entrypoints: ReturnType<typeof entry>[]) => ({
      format: 3 as const,
      entrypoints,
      types: [],
    });

    const web = await app(["default"], principal, documented(entry("default", [])));

    const mixed = await app(
      ["default", "Reader"],
      principal,
      documented(entry("default", []), entry("Reader", [])),
    );

    const rpc = await app(["default"], principal, documented(entry("default", ["status"])));

    const http = await app(
      ["default"],
      principal,
      documented(entry("default", [], "Order export over HTTP.")),
    );

    const undocumented = await app(["default"]);
    const catalog = (await services().services(principal)).unwrap();
    const listed = (id: string) => catalog.find((service) => service.appId === id)?.entrypoints;

    expect(listed(web.id)).toBeUndefined();
    expect(listed(mixed.id)).toEqual(["Reader"]);
    expect(listed(rpc.id)).toEqual(["default"]);
    expect(listed(http.id)).toEqual(["default"]);
    expect(listed(undocumented.id)).toEqual(["default"]);
    const source = await app();
    const grant = { app: web.id, entrypoint: "default" };
    expect((await services().bind(principal, source.id, "WEB", grant)).unwrap().grants).toEqual({
      WEB: grant,
    });
  });

  it("describes deployed apps that the catalog omits by slug or ID", async () => {
    const target = await app(["default"], principal, {
      format: 3,
      entrypoints: [
        { name: "default", summary: "", remarks: "", examples: [], http: true, methods: [] },
      ],
      types: [],
    });

    const describe = async (service: string) =>
      (await services().describe(principal, service)).unwrap().appId;

    const catalog = (await services().services(principal)).unwrap();
    expect(catalog.some((entry) => entry.appId === target.id)).toBe(false);
    expect(await describe(target.slug)).toBe(target.id);
    expect(await describe(target.id)).toBe(target.id);
    expect(await describe(target.id.toUpperCase())).toBe(target.id);
  });

  it("publishes app APIs and grants connections only in the owning organization", async () => {
    const source = await app();
    const target = await app(["Reader"]);
    expect((await services().services(principal)).unwrap()).toContainEqual({
      appId: target.id,
      slug: target.slug,
      displayName: target.displayName,
      entrypoints: ["Reader"],
    });
    const grant = { app: target.id, entrypoint: "Reader" };
    expect((await services().bind(principal, source.id, "ERP", grant)).unwrap().grants).toEqual({
      ERP: grant,
    });
    expect(
      await services().bind(
        { ...principal, application: { organizationId: "foreign", admin: true } },
        source.id,
        "ERP",
        grant,
      ),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(
      await services().bind(principal, source.id, "ERP", { ...grant, entrypoint: "Writer" }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await services().bind(principal, source.id, "ASSETS", grant)).toMatchObject({
      error: { code: "CONFLICT" },
    });
  });

  const person = async () => {
    const user = environment.users.createUser({
      name: "App creator",
      email: `${crypto.randomUUID()}@example.test`,
    });

    await environment.users.saveUser(user);
    await environment.linkMicrosoftUser(user.id);

    return {
      ...principal,
      id: user.id,
      admin: false,
      role: "member" as const,
      application: { ...principal.application, admin: false },
    };
  };

  it("lets anyone who manages the caller connect any API in the organization", async () => {
    const creator = await person();
    const other = await person();
    const source = await app([], creator);
    const target = await app(["Reader", "Writer"]);
    const grant = { app: target.id, entrypoint: "Reader" };
    expect(await services().bind(other, source.id, "ERP", grant)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect((await services().bind(creator, source.id, "ERP", grant)).unwrap().grants).toEqual({
      ERP: grant,
    });
    expect(
      await services().bind(creator, source.id, "WRONG", { ...grant, entrypoint: "Missing" }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await services().bind(creator, source.id, "ASSETS", grant)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    const writer = { ...grant, entrypoint: "Writer" };
    expect((await services().bind(creator, source.id, "ERP", writer)).unwrap().grants).toEqual({
      ERP: writer,
    });
    expect((await services().bind(creator, source.id, "ERP", null)).unwrap().grants).toEqual({});
  });

  it("lets an app manager retry a failed connection without a new revision", async () => {
    const creator = await person();
    const source = await app([], creator);
    const target = await app(["Reader"]);
    const grant = { app: target.id, entrypoint: "Reader" };
    (await services().bind(creator, source.id, "ERP", grant)).unwrap();
    await environment.database.db
      .update(apps)
      .set({ capabilityError: "Synthetic activation failure" })
      .where(eq(apps.id, source.id));

    const previous = await environment.database.db
      .select()
      .from(jobs)
      .where(eq(jobs.appId, source.id));

    expect((await services().bind(creator, source.id, "ERP", grant)).unwrap()).toMatchObject({
      revision: 1,
      error: null,
      state: "pending",
      grants: { ERP: grant },
    });
    expect(
      await environment.database.db.select().from(jobs).where(eq(jobs.appId, source.id)),
    ).toHaveLength(previous.length + 1);
  });

  it("describes only the active provider version in the selected organization, including rollback and legacy artifacts", async () => {
    const target = await app(["Reader"]);
    const legacy = (await services().reference(principal, target.id)).unwrap();
    expect(legacy.documentation).toBeNull();

    const first = contract.workerMetadata.parse(
      (
        await environment.database.db
          .select()
          .from(artifacts)
          .where(eq(artifacts.id, target.artifactId))
      )[0]?.metadata,
    );

    const documentation = (summary: string) =>
      contract.serviceDocumentation.parse({
        format: 3,
        entrypoints: [
          { name: "Reader", summary, remarks: "", examples: [], methods: [], http: false },
        ],
        types: [],
      });

    await environment.database.db
      .update(artifacts)
      .set({
        documentation: await documented(
          target.id,
          target.artifactId,
          documentation("First version"),
        ),
      })
      .where(eq(artifacts.id, target.artifactId));
    const nextArtifact = crypto.randomUUID();
    const nextDeployment = crypto.randomUUID();
    await environment.database.db.insert(artifacts).values({
      id: nextArtifact,
      appId: target.id,
      metadata: first,
      manifest: {},
      modules: [],
      documentation: await documented(target.id, nextArtifact, documentation("Next version")),
    });
    await environment.database.db.insert(deployments).values({
      id: nextDeployment,
      appId: target.id,
      artifactId: nextArtifact,
      status: "queued",
      requestId: crypto.randomUUID(),
    });
    expect((await services().reference(principal, target.slug)).unwrap().documentation).toEqual(
      documentation("First version"),
    );
    expect(
      await services().reference(
        { ...principal, application: { organizationId: "foreign", admin: true } },
        target.id,
      ),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: nextDeployment })
      .where(eq(apps.id, target.id));
    expect((await services().reference(principal, target.id)).unwrap()).toMatchObject({
      deploymentId: nextDeployment,
      documentation: documentation("Next version"),
    });
    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: legacy.deploymentId })
      .where(eq(apps.id, target.id));
    expect((await services().reference(principal, target.id)).unwrap().documentation).toEqual(
      documentation("First version"),
    );
  });

  it("lists an API's methods and describes selected methods with the types they use", async () => {
    const method = (
      name: string,
      summary: string,
      parameter: string,
      returns: string,
      uses: string[],
    ) => ({
      name,
      summary,
      remarks: "",
      examples: [],
      throws: [],
      signatures: [
        {
          parameters: [
            { name: "input", type: parameter, description: "", optional: false, rest: false },
          ],
          returns: { type: returns, description: "" },
          uses,
        },
      ],
    });

    const type = (name: string, definition: string, uses: string[] = []) => ({
      name,
      kind: "type" as const,
      definition,
      summary: "",
      remarks: "",
      examples: [],
      uses,
    });

    const target = await app(["Reader"], principal, {
      format: 3,
      entrypoints: [
        {
          name: "Reader",
          summary: "Read inventory.\nRemarks for every method.",
          remarks: "Pages hold up to 50 items.",
          examples: [],
          http: false,
          methods: [
            method("findItems", "Find items.\nMatches names.", "Query", "Promise<Page>", [
              "Page",
              "Query",
            ]),
            method("countItems", "Count items.", "string", "Promise<number>", []),
          ],
        },
      ],
      types: [
        type("Query", "type Query = { text: string };"),
        type("Page", "type Page = { items: Item[] };", ["Item"]),
        type("Item", "type Item = { id: string };"),
        type("Unused", "type Unused = { id: string };"),
      ],
    });

    const overview = (await services().describe(principal, target.id)).unwrap();
    expect(overview).toMatchObject({
      documented: true,
      methods: [
        { entrypoint: "Reader", name: "findItems", summary: "Find items." },
        { entrypoint: "Reader", name: "countItems", summary: "Count items." },
      ],
      documentation: null,
    });

    const selected = (
      await services().describe(principal, target.id, {
        entrypoint: "Reader",
        methods: ["findItems"],
        types: [],
      })
    ).unwrap().documentation;

    expect(selected?.entrypoint).toMatchObject({
      name: "Reader",
      remarks: "Pages hold up to 50 items.",
      methods: [{ name: "findItems" }],
    });
    // Types reached through other types are included; unrelated ones are not.
    expect(selected?.types.map((entry) => entry.name)).toEqual(["Query", "Page", "Item"]);
    expect(selected?.omittedTypes).toEqual([]);

    const named = (
      await services().describe(principal, target.id, {
        entrypoint: "Reader",
        methods: [],
        types: ["Page"],
      })
    ).unwrap().documentation;

    expect(named?.entrypoint.methods).toEqual([]);
    expect(named?.types.map((entry) => entry.name)).toEqual(["Page", "Item"]);

    const unknown = await services().describe(principal, target.id, {
      entrypoint: "Reader",
      methods: ["findItems", "deleteItems"],
      types: ["Missing"],
    });

    expect(unknown).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(unknown.isErr() ? unknown.error.message : "").toBe(
      "Reader has no documented method deleteItems, type Missing",
    );

    const entrypoint = await services().describe(principal, target.id, {
      entrypoint: "Writer",
      methods: [],
      types: ["Page"],
    });

    expect(entrypoint).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(entrypoint.isErr() ? entrypoint.error.message : "").toBe(
      "Writer is not a documented entrypoint",
    );
  });

  it("generates binding types from the active deployment for members of its organization", async () => {
    const undocumented = await app(["Reader"]);

    const missing = await services().types(principal, undocumented.slug, {
      entrypoint: "Reader",
      binding: "INVENTORY",
    });

    expect(missing).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(missing.isErr() ? missing.error.message : "").toBe(
      `${undocumented.slug} has no API documentation; redeploy it to publish its types`,
    );

    const target = await app(["Reader"], principal, {
      format: 3,
      entrypoints: [
        {
          name: "Reader",
          summary: "Read inventory.",
          remarks: "",
          examples: [],
          http: false,
          methods: [
            {
              name: "count",
              summary: "Count items.",
              remarks: "",
              examples: [],
              throws: [],
              signatures: [
                {
                  parameters: [],
                  returns: { type: "Promise<Count>", description: "" },
                  uses: ["Count"],
                },
              ],
            },
          ],
        },
      ],
      types: [
        {
          name: "Count",
          kind: "interface",
          definition: "{\n    total: number;\n}",
          summary: "",
          remarks: "",
          examples: [],
        },
      ],
    });

    const generated = (
      await services().types(principal, target.id, { entrypoint: "Reader", binding: "INVENTORY" })
    ).unwrap();

    expect(generated).toMatchObject({
      appId: target.id,
      slug: target.slug,
      entrypoint: "Reader",
      binding: "INVENTORY",
    });
    expect(generated.declarations).toContain(
      `// Generated by \`widefleet services types ${target.slug} --entrypoint Reader --as INVENTORY\``,
    );
    expect(generated.declarations).toContain("  count(): Promise<INVENTORY.Result<Count>>;");
    expect(generated.declarations).toContain("export interface Count {\n    total: number;\n}");

    const entrypoint = await services().types(principal, target.id, {
      entrypoint: "Writer",
      binding: "INVENTORY",
    });

    expect(entrypoint).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(entrypoint.isErr() ? entrypoint.error.message : "").toBe(
      "Writer is not a documented entrypoint",
    );

    const taken = await services().types(principal, target.id, {
      entrypoint: "Reader",
      binding: "Count",
    });

    expect(taken).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(taken.isErr() ? taken.error.message : "").toBe(
      "The API documents a type named Count; choose another binding name",
    );

    const foreign = await services().types(
      { ...principal, application: { organizationId: "foreign", admin: true } },
      target.id,
      { entrypoint: "Reader", binding: "INVENTORY" },
    );

    expect(foreign).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("resolves UUID-shaped slugs with app IDs taking precedence within the selected organization", async () => {
    const named = await app(["Reader"]);
    const slug = `a${crypto.randomUUID().slice(1)}`;
    await environment.database.db.update(apps).set({ slug }).where(eq(apps.id, named.id));
    expect((await services().describe(principal, slug)).unwrap().appId).toBe(named.id);

    const artifactId = crypto.randomUUID();
    const deploymentId = crypto.randomUUID();
    await environment.database.db.insert(apps).values({
      id: slug,
      slug: `id-${slug}`,
      displayName: "ID match",
      organizationId: principal.application.organizationId,
      ownerId: principal.id,
      hostname: `id-${slug}.apps.localhost`,
      activeDeploymentId: deploymentId,
      state: "active",
    });
    await environment.database.db.insert(artifacts).values({
      id: artifactId,
      appId: slug,
      metadata: contract.workerMetadata.parse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        entrypoints: ["Reader"],
        assets: { upload_session: artifactId },
      }),
      manifest: {},
      modules: [],
    });
    await environment.database.db.insert(deployments).values({
      id: deploymentId,
      appId: slug,
      artifactId,
      status: "succeeded",
      requestId: crypto.randomUUID(),
    });
    expect((await services().describe(principal, slug)).unwrap().appId).toBe(slug);
    expect(
      await services().describe(
        { ...principal, application: { organizationId: "foreign", admin: true } },
        slug,
      ),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("rejects cycles through desired or still-active connections", async () => {
    const a = await app(["Reader"]);
    const b = await app(["Reader"]);
    (await services().bind(principal, a.id, "B", { app: b.id, entrypoint: "Reader" })).unwrap();
    expect(
      await services().bind(principal, b.id, "A", { app: a.id, entrypoint: "Reader" }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    await environment.database.db
      .update(apps)
      .set({
        capabilities: {},
        appliedCapabilities: { revision: 1, grants: { B: { app: b.id, entrypoint: "Reader" } } },
      })
      .where(eq(apps.id, a.id));
    expect(
      await services().bind(principal, b.id, "A", { app: a.id, entrypoint: "Reader" }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(
      await services().bind(principal, a.id, "SELF", { app: a.id, entrypoint: "Reader" }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("blocks deletion and rollback that remove referenced APIs, including pending revocations", async () => {
    const source = await app();
    const target = await app(["Reader"]);
    (
      await services().bind(principal, source.id, "ERP", { app: target.id, entrypoint: "Reader" })
    ).unwrap();
    const oldId = crypto.randomUUID();
    await environment.database.db.insert(artifacts).values({
      id: oldId,
      appId: target.id,
      metadata: contract.workerMetadata.parse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        assets: { upload_session: oldId },
      }),
      manifest: {},
      modules: [],
    });
    expect(
      await applications().rollback(principal, target.id, oldId, crypto.randomUUID()),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await applications().remove(principal, target.id)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    await environment.database.db
      .update(apps)
      .set({
        capabilities: {},
        appliedCapabilities: {
          revision: 1,
          grants: { ERP: { app: target.id, entrypoint: "Reader" } },
        },
      })
      .where(eq(apps.id, source.id));
    expect(await applications().remove(principal, target.id)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    await environment.database.db
      .update(apps)
      .set({ appliedCapabilities: { revision: 2, grants: {} } })
      .where(eq(apps.id, source.id));
    expect((await applications().remove(principal, target.id)).unwrap()).toEqual({
      accepted: true,
    });
  });

  it("keeps encrypted secrets private to their app and deploys changes through its existing lifecycle", async () => {
    const target = await app(["Reader"]);
    const source = await app();
    (
      await services().bind(principal, source.id, "ERP", { app: target.id, entrypoint: "Reader" })
    ).unwrap();
    const result = (await secrets().set(principal, target.id, "TOKEN", "synthetic-value")).unwrap();
    expect(result).toMatchObject({
      names: ["TOKEN"],
      revision: 1,
      deployment: { appId: target.id, artifactId: target.artifactId, status: "queued" },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-value");

    const [record] = await environment.database.db
      .select()
      .from(apps)
      .where(eq(apps.id, target.id));

    const values = contract.appSecretPreparation.shape.values.parse(record?.secrets);
    expect(values["TOKEN"]).not.toBe("synthetic-value");
    expect(
      await decryptSecret(environment.environment.PLATFORM_ENCRYPTION_KEY, values["TOKEN"] ?? ""),
    ).toBe("synthetic-value");
    expect((await secrets().read(principal, source.id)).unwrap().names).toEqual([]);

    const consumer = {
      ...principal,
      id: "consumer-only",
      application: { ...principal.application, admin: false },
    };

    expect(await secrets().read(consumer, target.id)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    const removed = (await secrets().set(principal, target.id, "TOKEN", null)).unwrap();
    expect(removed).toMatchObject({ names: [], revision: 2 });
  });
  it("preserves pending code selection when changing secrets", async () => {
    const target = await app(["Reader"]);
    const latestArtifact = crypto.randomUUID();

    const [original] = await environment.database.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, target.artifactId));

    if (!original) throw new Error("Missing fixture artifact");
    await environment.database.db.insert(artifacts).values({ ...original, id: latestArtifact });
    await environment.database.db.insert(deployments).values({
      id: crypto.randomUUID(),
      appId: target.id,
      artifactId: latestArtifact,
      status: "queued",
      requestId: crypto.randomUUID(),
    });
    const result = (await secrets().set(principal, target.id, "TOKEN", "synthetic-new")).unwrap();
    expect(result.deployment?.artifactId).toBe(latestArtifact);
  });

  it("protects native grants published before their activation acknowledgement", async () => {
    const source = await app();
    const target = await app(["Reader"]);
    await environment.database.db.insert(jobs).values({
      id: crypto.randomUUID(),
      organizationId: "widefleet",
      appId: source.id,
      kind: "configure",
      state: "running",
      capabilities: { revision: 1, grants: { ERP: { app: target.id, entrypoint: "Reader" } } },
    });
    expect(await applications().remove(principal, target.id)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    await environment.database.db
      .update(apps)
      .set({ appliedCapabilityRevision: 2, appliedCapabilities: { revision: 2, grants: {} } })
      .where(eq(apps.id, source.id));
    expect((await applications().remove(principal, target.id)).unwrap()).toEqual({
      accepted: true,
    });
  });
});
