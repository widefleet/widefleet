import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { member, organization } from "../src/lib/server/auth-schema.ts";
import { apps, appGrants, fleets, jobs, connectors, agents } from "../src/lib/server/schema.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createAppAccessService } from "../src/lib/server/app-access.ts";
import { createNetworkService } from "../src/lib/server/network.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { registerCloudflareRemoval } from "../src/lib/server/cloudflare-removal-admission.ts";
import { cloudflareRemovalCommand } from "../src/lib/server/cloudflare-removal-command.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { connectorReference } from "../src/lib/server/connector-package.ts";

describe("Mandatory application context", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let service: ReturnType<typeof createAppService>;
  let first: Awaited<ReturnType<typeof scope>>;
  let second: Awaited<ReturnType<typeof scope>>;

  const scope = async (label: string) => {
    const organizationId = crypto.randomUUID();
    const fleetId = crypto.randomUUID();
    await environment.database.db.insert(organization).values({
      id: organizationId,
      name: label,
      slug: label,
      createdAt: new Date(),
    });
    await environment.database.db.insert(fleets).values({
      id: fleetId,
      name: label,
      organizationId,
      appHostnameSuffix: label,
    });
    const person = environment.users.createUser({ name: label, email: `${label}@example.test` });
    await environment.users.saveUser(person);
    await environment.database.db.insert(member).values({
      id: crypto.randomUUID(),
      userId: person.id,
      organizationId,
      role: "admin",
      createdAt: new Date(),
    });
    const headers = new Headers((await environment.users.login({ userId: person.id })).headers);
    headers.set("origin", environment.configuration.PLATFORM_URL);
    headers.set("x-widefleet-organization", organizationId);

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
      { filterFleets: async (candidates) => candidates.map((candidate) => candidate.id) },
    );

    const authenticate = () =>
      identity.authenticate(
        new Request(environment.configuration.PLATFORM_URL, { headers }),
        "platform:write",
      );

    return {
      organizationId,
      fleetId,
      person,
      headers,
      authenticate,
      principal: (await authenticate()).unwrap(),
    };
  };

  beforeAll(async () => {
    environment = await createTestEnvironment();
    service = createAppService(environment.database.db, environment.configuration);
    first = await scope("first");
    second = await scope("second");
  });
  beforeEach(async () => {
    await environment.database.db.delete(apps);
  });
  afterAll(async () => {
    await environment.close();
  });

  const runtime = () =>
    createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      reporting: environment.reporting,
      storage: createStorage(environment.configuration),
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
      fleetAccess: {
        filterFleets: async (candidates) => candidates.map((candidate) => candidate.id),
      },
    })();

  it("scopes connector and agent discovery and denies installation administration", async () => {
    const current = await runtime();

    for (const target of [first, second]) {
      const reference = connectorReference.parse({
        name: "erp",
        checksum: "a".repeat(64),
        entrypoints: ["default", target === first ? "FirstReader" : "SecondReader"],
        classes: [],
      });

      await environment.database.db.insert(connectors).values({
        fleetId: target.fleetId,
        name: "erp",
        package: reference,
        appliedPackage: reference,
        jobId: crypto.randomUUID(),
      });
      await environment.database.db.insert(agents).values({
        id: crypto.randomUUID(),
        fleetId: target.fleetId,
        name: target === first ? "First agent" : "Second agent",
        tokenHash: crypto.randomUUID(),
      });
    }

    const catalog = [{ name: "erp", entrypoints: ["default", "FirstReader"] }];
    expect((await current.connectors.catalog(first.principal)).unwrap()).toEqual(catalog);
    const listing = (await current.agents.list(first.principal)).unwrap();
    expect(listing.map((agent) => agent.name)).toEqual(["First agent"]);
    expect(await current.agents.create(first.principal, { name: "Forbidden" })).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    // Even installation administration cannot mutate an agent outside its selected fleet.
    expect(
      await current.agents.disable({ ...second.principal, admin: true }, listing[0]?.id ?? ""),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    const api = createApi(current);

    const request = (path: string) =>
      new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, {
        headers: first.headers,
      });

    expect(await (await api(request("/connector-catalog"))).json()).toEqual(catalog);
    expect(await (await api(request("/agents"))).json()).toEqual(listing);

    for (const path of [
      "/runtime",
      "/settings",
      "/reporting",
      "/groups?query=Engineering&limit=10",
    ])
      expect((await api(request(path))).status).toBe(403);
  });

  it("allows the same name in separate fleets and scopes administrator, owner and grant access", async () => {
    const input = { slug: "notes", displayName: "Notes", parentId: null };

    const [a, b] = await Promise.all([
      service.create(first.principal, input),
      service.create(second.principal, input),
    ]);

    expect(a.unwrap().hostname).toBe("notes-first.apps.localhost");
    expect(b.unwrap().hostname).toBe("notes-second.apps.localhost");
    expect((await service.list(first.principal)).unwrap().map((app) => app.id)).toEqual([
      a.unwrap().id,
    ]);
    expect((await service.resolve(second.principal, "notes")).unwrap().id).toBe(b.unwrap().id);
    expect(await service.create(first.principal, input)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect(first.principal).toMatchObject({ admin: false, application: { admin: true } });

    // Neither ownership nor an incorrectly imported grant may widen the fleet boundary.
    await environment.database.db
      .update(apps)
      .set({ ownerId: first.person.id })
      .where(eq(apps.id, b.unwrap().id));
    await environment.database.db
      .insert(appGrants)
      .values({ appId: b.unwrap().id, userId: first.person.id });

    const ordinary = {
      ...first.principal,
      application: { ...first.principal.application, admin: false },
    };

    expect(await service.get(ordinary, b.unwrap().id)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect((await service.list(ordinary)).unwrap().map((app) => app.id)).toEqual([a.unwrap().id]);

    for (const operation of [
      service.get(first.principal, b.unwrap().id),
      service.history(first.principal, b.unwrap().id),
      service.access(first.principal, b.unwrap().id, ""),
      service.remove(first.principal, b.unwrap().id),
      service.grant(first.principal, b.unwrap().id, first.person.id),
      service.create(first.principal, { ...input, slug: "preview", parentId: b.unwrap().id }),
      createNetworkService(environment.database.db).read(first.principal, b.unwrap().id),
      createAppAccessService(environment.database.db).read(first.principal, b.unwrap().id),
    ])
      expect(await operation).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await environment.database.db.select().from(jobs)).toEqual([]);
    expect((await service.get(second.principal, b.unwrap().id)).unwrap().id).toBe(b.unwrap().id);

    await environment.database.db
      .update(apps)
      .set({ state: "active", activeDeploymentId: crypto.randomUUID(), catalogListed: true });
    expect((await service.catalog(first.principal)).unwrap().map((app) => app.id)).toEqual([
      a.unwrap().id,
    ]);
    expect(await service.grant(first.principal, a.unwrap().id, second.person.id)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    const directory = (await service.access(first.principal, a.unwrap().id, "second")).unwrap();
    expect(directory.candidates).toEqual([]);
  });

  it("keeps named previews in the same flat namespace and rejects occupied hostnames", async () => {
    const input = { slug: "notes", displayName: "Notes", parentId: null };
    const parent = (await service.create(first.principal, input)).unwrap();
    const other = (await service.create(second.principal, input)).unwrap();

    const previewInput = {
      slug: "notes-review",
      displayName: "Review",
      parentId: parent.id,
      previewName: "review",
    };

    const preview = (await service.create(first.principal, previewInput)).unwrap();

    const otherPreview = (
      await service.create(second.principal, { ...previewInput, parentId: other.id })
    ).unwrap();

    expect(preview.hostname).toBe("review-notes-first.apps.localhost");
    expect(preview.url).toBe("https://review-notes-first.apps.localhost/");
    expect(otherPreview.hostname).toBe("review-notes-second.apps.localhost");
    expect(await service.get(second.principal, preview.id)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(
      await service.create(second.principal, { ...previewInput, slug: "foreign-preview" }),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(
      await service.create(first.principal, { ...previewInput, slug: "different-preview" }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await service.create(first.principal, { ...input, slug: "review-notes" })).toMatchObject(
      { error: { code: "CONFLICT" } },
    );
    expect((await service.list(first.principal)).unwrap()).toHaveLength(2);
  });

  it("reserves complete hostnames atomically across different fleet suffixes", async () => {
    const combined = await scope("first-second");

    const outcomes = await Promise.all([
      service.create(combined.principal, { slug: "notes", displayName: "Notes", parentId: null }),
      service.create(second.principal, {
        slug: "notes-first",
        displayName: "Other notes",
        parentId: null,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.isOk())).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.isErr())).toMatchObject([
      { error: { code: "CONFLICT" } },
    ]);
    const records = await environment.database.db.select().from(apps);
    expect(records).toHaveLength(1);
    expect(records[0]?.hostname).toBe("notes-first-second.apps.localhost");
  });

  it("enforces the DNS label limit for flat apps and previews before writing", async () => {
    const boundary = await scope("a".repeat(14));
    const overflow = await scope("a".repeat(15));
    const input = { slug: "n".repeat(48), displayName: "Notes", parentId: null };
    const full = (await service.create(boundary.principal, input)).unwrap();
    expect(full.hostname.split(".")[0]).toHaveLength(63);
    expect(await service.create(overflow.principal, input)).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect((await service.list(overflow.principal)).unwrap()).toEqual([]);

    const parent = (await service.create(first.principal, input)).unwrap();

    const previewInput = {
      slug: "boundary-preview",
      displayName: "Review",
      parentId: parent.id,
      previewName: "r".repeat(8),
    };

    const preview = (await service.create(first.principal, previewInput)).unwrap();
    expect(preview.hostname.split(".")[0]).toHaveLength(63);
    expect(
      await service.create(first.principal, {
        ...previewInput,
        slug: "overflow-preview",
        previewName: "r".repeat(9),
      }),
    ).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect((await service.list(first.principal)).unwrap()).toHaveLength(2);
  });

  it("rechecks membership and role when selecting a scope with an existing session", async () => {
    first.headers.set("x-widefleet-organization", second.organizationId);
    expect(await first.authenticate()).toMatchObject({ error: { code: "FORBIDDEN" } });
    first.headers.set("x-widefleet-organization", first.organizationId);
    await environment.database.db
      .update(member)
      .set({ role: "member" })
      .where(
        and(eq(member.userId, first.person.id), eq(member.organizationId, first.organizationId)),
      );
    expect((await first.authenticate()).unwrap()).toMatchObject({ application: { admin: false } });
    await environment.database.db
      .update(member)
      .set({ role: "admin" })
      .where(eq(member.userId, first.person.id));
  });

  it("retains the boundary when a background entrypoint opens another database connection", async () => {
    const target = (
      await service.create(second.principal, {
        slug: "background",
        displayName: "Background",
        parentId: null,
      })
    ).unwrap();

    const own = (
      await service.create(first.principal, {
        slug: "background",
        displayName: "Background",
        parentId: null,
      })
    ).unwrap();

    const command = cloudflareRemovalCommand.parse({
      kind: "remove",
      id: crypto.randomUUID(),
      appId: target.id,
      actor: first.principal,
      createdAt: new Date().toISOString(),
    });

    const background = createDatabase(environment.configuration);

    try {
      expect(await registerCloudflareRemoval(background.db, command)).toMatchObject({
        error: { code: "NOT_FOUND" },
      });
      expect(
        cloudflareRemovalCommand.safeParse({
          ...command,
          actor: { id: first.person.id, admin: true },
        }).success,
      ).toBe(false);
      await environment.database.db
        .update(fleets)
        .set({ executor: "cloudflare" })
        .where(eq(fleets.id, first.fleetId));
      expect(
        (await registerCloudflareRemoval(background.db, { ...command, appId: own.id })).unwrap(),
      ).toEqual([{ id: own.id, hostname: own.hostname }]);
    } finally {
      await environment.database.db
        .update(fleets)
        .set({ executor: "agent" })
        .where(eq(fleets.id, first.fleetId));
      await background.close();
    }
  });

  it("refuses a cross-fleet legacy preview tree without partially changing either app", async () => {
    const input = { slug: "tree", displayName: "Tree", parentId: null };
    const parent = (await service.create(first.principal, input)).unwrap();
    const foreign = (await service.create(second.principal, input)).unwrap();
    await environment.database.db
      .update(apps)
      .set({ parentId: parent.id })
      .where(eq(apps.id, foreign.id));
    const access = createAppAccessService(environment.database.db);
    expect((await access.read(first.principal, parent.id)).unwrap().previews).toEqual([]);
    expect(
      await access.change(first.principal, parent.id, { revision: 0, groups: ["engineering"] }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await service.remove(first.principal, parent.id)).toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect((await access.read(first.principal, parent.id)).unwrap().groups).toEqual([]);
    expect((await service.get(second.principal, foreign.id)).unwrap().state).toBe("created");
    expect(await environment.database.db.select().from(jobs)).toEqual([]);
  });

  it("uses the same scope in runtime services and the HTTP API used by the CLI", async () => {
    const current = await runtime();

    const api = createApi(current);
    const headers = new Headers(first.headers);
    headers.set("content-type", "application/json");
    expect(
      (
        await api(
          new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps`, {
            method: "POST",
            headers,
            body: JSON.stringify({ slug: "api-app", displayName: "API App", parentId: null }),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await api(
          new Request(`${environment.configuration.PLATFORM_URL}/api/v1/reporting`, { headers }),
        )
      ).status,
    ).toBe(403);

    const result = await api(
      new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps`, {
        headers: first.headers,
      }),
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual((await current.apps.list(first.principal)).unwrap());
  });
});
