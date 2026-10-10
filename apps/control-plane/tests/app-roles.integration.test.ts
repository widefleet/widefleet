import { account } from "../src/lib/server/auth-schema.ts";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAppService } from "../src/lib/server/apps.ts";
import { createAppAccessService } from "../src/lib/server/app-access.ts";
import { appActions } from "../src/lib/server/app-permissions.ts";
import { providerIssuer } from "../src/lib/server/company-identity.ts";
import { createNetworkService } from "../src/lib/server/network.ts";
import { createWorkflowService } from "../src/lib/server/workflows.ts";
import { appRoleAssignments, apps, jobs } from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";

describe("App roles and ownership", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let service: ReturnType<typeof createAppService>;
  let access: ReturnType<typeof createAppAccessService>;
  let creator: ReturnType<typeof person>;
  let colleague: ReturnType<typeof person>;

  const person = (subject: string, groups: string[] = []) => ({
    id: subject,
    name: subject,
    email: `${subject}@example.test`,
    role: "member" as const,
    admin: false,
    creator: true,
    company: {
      provider: providerIssuer(environment.configuration.IDENTITY.provider),
      subject,
      groups,
      groupsExpired: false,
      expiresAt: Date.now() + 60_000,
      overage: false,
    },
  });

  const recipient = (subject: string, type: "user" | "group" = "user") => ({
    type,
    subject,
    provider: creator.company.provider,
  });

  const create = async (slug: string, parentId: string | null = null) =>
    (await service.create(creator, { slug, displayName: slug, parentId })).unwrap();

  const grant = async (
    appId: string,
    subject: string,
    role: "user" | "developer" | "admin",
    type: "user" | "group" = "user",
  ) => {
    const current = (await access.roles(creator, appId)).unwrap();

    return (
      await access.grant(creator, appId, {
        principal: recipient(subject, type),
        role,
        revision: current.revision,
      })
    ).unwrap();
  };

  beforeAll(async () => {
    environment = await createTestEnvironment();
    service = createAppService(environment.database.db, environment.configuration);
    access = createAppAccessService(environment.database.db, environment.configuration);
    creator = person("creator");
    colleague = person("colleague");
  });
  beforeEach(async () => {
    await environment.database.db.delete(apps);
  });
  afterAll(async () => {
    await environment.close();
  });

  it("starts with one personal owner and a closed audience", async () => {
    const app = await create("personal");
    const state = (await access.roles(creator, app.id)).unwrap();
    expect(state.assignments).toHaveLength(1);
    expect(state.assignments[0]).toMatchObject({ principal: recipient("creator"), role: "owner" });
    expect((await access.read(creator, app.id)).unwrap()).toMatchObject({
      groups: [],
      users: ["creator"],
      allAuthenticated: false,
      state: "saved",
    });
    expect(await service.get(colleague, app.id)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("requires a development role for workflow operations, including inherited previews", async () => {
    const app = await create("workflows");
    const preview = await create("workflow-preview", app.id);
    await environment.database.db.update(apps).set({ activeDeploymentId: crypto.randomUUID() });
    const workflows = createWorkflowService(environment.database.db);
    const request = { action: "restart" as const, workflow: "EXAMPLE", id: "instance" };
    await grant(app.id, "colleague", "user");
    expect(
      await workflows.create(colleague, preview.id, crypto.randomUUID(), request),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    const granted = await grant(app.id, "colleague", "developer");

    const operation = (
      await workflows.create(colleague, preview.id, crypto.randomUUID(), request)
    ).unwrap();

    expect(operation.state).toBe("queued");
    expect(await appActions(environment.database.db, colleague, app.id)).toContain("workflows");
    const assignment = granted.assignments.find(({ role }) => role === "developer");

    if (!assignment) throw new Error("Missing developer assignment");
    (
      await access.revoke(creator, app.id, {
        assignmentId: assignment.id,
        revision: granted.revision,
      })
    ).unwrap();
    expect(await workflows.read(colleague, preview.id, operation.id)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("resolves existing members to the same company person used by app SSO", async () => {
    const member = environment.users.createUser({
      name: "Linked Member",
      email: "linked@example.test",
    });

    await environment.users.saveUser(member);
    const subject = crypto.randomUUID();
    await environment.linkMicrosoftUser(member.id, subject);
    const idToken = `${Buffer.from('{"alg":"fixture"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: creator.company.provider, tid: "00000000-0000-4000-8000-000000000001", sub: "client-specific", oid: subject, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.fixture`;
    await environment.database.db
      .update(account)
      .set({ idToken })
      .where(eq(account.userId, member.id));
    const app = await create("member-identity");

    const result = (
      await access.grant(creator, app.id, {
        revision: 1,
        role: "developer",
        principal: { type: "user", provider: "widefleet", subject: member.id },
      })
    ).unwrap();

    expect(result.assignments).toContainEqual(
      expect.objectContaining({ principal: recipient(subject), role: "developer" }),
    );
    expect((await access.read(creator, app.id)).unwrap().users).toContain(subject);
    expect((await access.candidates(creator, app.id, "linked@example.test")).unwrap()).toEqual([
      { name: member.name, email: member.email, principal: recipient(subject) },
    ]);
  });

  it("enforces the role matrix and combines personal and group assignments", async () => {
    const app = await create("matrix");
    await grant(app.id, "colleague", "user");
    expect(await appActions(environment.database.db, colleague, app.id)).toEqual(["use"]);
    expect(await service.get(colleague, app.id)).toMatchObject({ error: { code: "NOT_FOUND" } });
    await grant(app.id, "engineering", "developer", "group");
    const developer = person("colleague", ["engineering"]);
    expect((await service.get(developer, app.id)).unwrap().id).toBe(app.id);
    expect(await service.remove(developer, app.id)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(
      await createNetworkService(environment.database.db).change(developer, app.id, {
        target: "backend",
        action: "allow",
        origins: ["https://api.example.test"],
      }),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    await grant(app.id, "colleague", "admin");
    const current = (await access.roles(colleague, app.id)).unwrap();
    expect(current.actions).toContain("delete");
    expect(current.actions).not.toContain("transfer");
    expect(
      await access.transfer(colleague, app.id, {
        principal: recipient("colleague"),
        revision: current.revision,
      }),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("scopes group IDs to the issuer and removes group rights on the next request", async () => {
    const app = await create("groups");
    await grant(app.id, "engineering", "developer", "group");
    const member = person("colleague", ["engineering"]);
    expect((await service.get(member, app.id)).unwrap().id).toBe(app.id);
    expect(
      await service.get(
        { ...member, company: { ...member.company, provider: "https://other.example.test" } },
        app.id,
      ),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await service.get(person("colleague"), app.id)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect((await access.read(creator, app.id)).unwrap()).toMatchObject({
      groups: ["engineering"],
      users: ["creator"],
    });
  });

  it("inherits roles and owner through previews without inheriting network grants", async () => {
    const app = await create("root");
    await grant(app.id, "colleague", "developer");

    const preview = (
      await service.create(colleague, {
        slug: "preview",
        displayName: "Preview",
        parentId: app.id,
        previewName: "review",
      })
    ).unwrap();

    expect((await service.get(creator, preview.id)).unwrap().id).toBe(preview.id);
    const inherited = (await access.roles(colleague, preview.id)).unwrap();
    expect(inherited.inheritedFrom).toBe(app.id);
    expect(
      inherited.assignments.find((assignment) => assignment.role === "owner")?.principal,
    ).toEqual(recipient("creator"));
    const state = (await access.roles(creator, app.id)).unwrap();
    expect(
      await access.grant(creator, preview.id, {
        principal: recipient("other"),
        role: "admin",
        revision: state.revision,
      }),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    await access.transfer(creator, app.id, {
      principal: recipient("ops", "group"),
      revision: state.revision,
    });
    const newOwner = person("operator", ["ops"]);
    expect((await access.roles(newOwner, preview.id)).unwrap().actions).toContain("transfer");
    expect(await service.get(creator, app.id)).toMatchObject({ error: { code: "NOT_FOUND" } });

    const [stored] = await environment.database.db
      .select()
      .from(apps)
      .where(eq(apps.id, preview.id));

    expect(stored).toMatchObject({
      accessGroups: ["ops"],
      accessUsers: ["colleague"],
      networkPolicy: { backend: [], browser: [] },
      capabilities: {},
    });
    expect(
      await environment.database.db
        .select()
        .from(appRoleAssignments)
        .where(eq(appRoleAssignments.appId, preview.id)),
    ).toEqual([]);
  });

  it("serializes competing transfers and preserves exactly one owner", async () => {
    const app = await create("transfer");
    const current = (await access.roles(creator, app.id)).unwrap();

    const results = await Promise.all(
      ["first", "second"].map((subject) =>
        access.transfer({ ...creator, admin: true }, app.id, {
          principal: recipient(subject),
          revision: current.revision,
        }),
      ),
    );

    expect(results.filter((result) => result.isOk())).toHaveLength(1);
    expect(results.find((result) => result.isErr())).toMatchObject({ error: { code: "CONFLICT" } });

    const [owner] = await environment.database.db
      .select()
      .from(appRoleAssignments)
      .where(and(eq(appRoleAssignments.appId, app.id), eq(appRoleAssignments.role, "owner")));

    if (!owner) throw new Error("Owner missing");
    await expect(
      environment.database.db.delete(appRoleAssignments).where(eq(appRoleAssignments.id, owner.id)),
    ).rejects.toThrow();
    expect(
      await access.revoke(person(owner.subject), app.id, {
        assignmentId: owner.id,
        revision: current.revision + 1,
      }),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("keeps platform recovery independent of app use and waits for gateway activation", async () => {
    const app = await create("recovery");
    const platformAdmin = { ...colleague, admin: true };
    expect((await access.roles(platformAdmin, app.id)).unwrap().actions).not.toContain("use");
    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: crypto.randomUUID(), appliedAccessRevision: 1 })
      .where(eq(apps.id, app.id));

    const result = (
      await access.change(creator, app.id, { revision: 1, allAuthenticated: true })
    ).unwrap();

    expect(result).toMatchObject({
      revision: 2,
      appliedRevision: 1,
      state: "pending",
      allAuthenticated: true,
    });
    expect(
      await environment.database.db.select().from(jobs).where(eq(jobs.appId, app.id)),
    ).toHaveLength(1);
    expect(
      await access.change(creator, app.id, { revision: 1, allAuthenticated: false }),
    ).toMatchObject({ error: { code: "CONFLICT" } });
  });
});
