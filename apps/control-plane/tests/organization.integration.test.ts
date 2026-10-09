import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installationOrganizationId } from "../src/lib/organization.ts";
import { apiResource } from "../src/lib/server/auth-options.ts";
import { member } from "../src/lib/server/auth-schema.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { findMembers } from "../src/lib/server/member-directory.ts";
import { initializeOrganization } from "../src/lib/server/organization.ts";
import { createTestEnvironment } from "./environment.ts";

describe("Installation organization", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => {
    await environment.close();
  });

  const person = async (name: string, bootstrap = false) => {
    const record = environment.users.createUser({
      name,
      email: `${crypto.randomUUID()}@example.test`,
    });

    await environment.users.saveUser(record);
    await environment.linkMicrosoftUser(
      record.id,
      bootstrap ? environment.ownerSubject : crypto.randomUUID(),
    );
    const session = await environment.users.login({ userId: record.id });
    const headers = new Headers(session.headers);
    headers.set("origin", environment.configuration.PLATFORM_URL);

    const [membership] = await environment.database.db
      .select()
      .from(member)
      .where(eq(member.userId, record.id));

    if (!membership) throw new Error("Expected membership");

    return { record, membership, headers };
  };

  const post = (path: string, headers: Headers, body: Record<string, string | string[]>) => {
    const credentials = new Headers(headers);
    credentials.set("content-type", "application/json");

    return environment.auth.handler(
      new Request(`${environment.configuration.PLATFORM_URL}/api/auth/organization/${path}`, {
        method: "POST",
        headers: credentials,
        body: JSON.stringify(body),
      }),
    );
  };

  const role = (headers: Headers, memberId: string, value: string | string[]) =>
    post("update-member-role", headers, {
      memberId,
      role: value,
      organizationId: installationOrganizationId,
    });

  it("keeps the explicitly created owner and does not promote users on startup", async () => {
    const second = await person("New Member");
    await initializeOrganization(environment.database.db);
    const roles = await environment.database.db.select().from(member);
    expect(roles.find((entry) => entry.userId === environment.owner.id)?.role).toBe("owner");
    expect(roles.find((entry) => entry.userId === second.record.id)?.role).toBe("member");
  });

  it("uses Better Auth roles and rechecks existing browser and CLI sessions", async () => {
    const [owner] = await environment.database.db
      .select()
      .from(member)
      .where(eq(member.role, "owner"));

    if (!owner) throw new Error("Expected bootstrap owner");

    const ownerHeaders = new Headers(
      (await environment.users.login({ userId: owner.userId })).headers,
    );

    ownerHeaders.set("origin", environment.configuration.PLATFORM_URL);
    const candidate = await person("Role Changes");

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
    );

    const now = Math.floor(Date.now() / 1000);

    const { token } = await environment.auth.api.signJWT({
      body: {
        payload: {
          sub: candidate.record.id,
          aud: apiResource(environment.configuration),
          iss: `${environment.configuration.PLATFORM_URL}/api/auth`,
          iat: now,
          exp: now + 300,
          scope: "platform:read platform:write",
        },
      },
    });

    const authenticate = (headers: Headers) =>
      identity.authenticate(
        new Request(apiResource(environment.configuration), { headers }),
        "platform:write",
      );

    const cliHeaders = new Headers({ authorization: `Bearer ${token}` });

    expect(await authenticate(candidate.headers)).toMatchObject({
      value: { admin: false, creator: true, role: "member" },
    });
    expect((await role(candidate.headers, candidate.membership.id, "admin")).status).toBe(403);
    expect((await role(ownerHeaders, candidate.membership.id, "admin")).status).toBe(200);

    for (const headers of [candidate.headers, cliHeaders])
      expect(await authenticate(headers)).toMatchObject({
        value: { admin: true, creator: true, role: "admin" },
      });

    expect((await role(candidate.headers, owner.id, "member")).status).toBe(403);
    expect((await role(candidate.headers, candidate.membership.id, "owner")).status).toBe(403);
    expect((await role(ownerHeaders, candidate.membership.id, ["admin", "member"])).status).toBe(
      400,
    );
    expect((await role(ownerHeaders, candidate.membership.id, "creator")).status).toBe(400);

    const foreign = new Headers(ownerHeaders);
    foreign.set("origin", "https://foreign.example.test");
    expect((await role(foreign, candidate.membership.id, "admin")).status).toBe(403);
    expect((await role(ownerHeaders, candidate.membership.id, "member")).status).toBe(200);
    await initializeOrganization(environment.database.db);

    for (const headers of [candidate.headers, cliHeaders])
      expect(await authenticate(headers)).toMatchObject({
        value: { admin: false, creator: true, role: "member" },
      });

    await environment.database.db.delete(member).where(eq(member.id, candidate.membership.id));
    await initializeOrganization(environment.database.db);
    expect((await authenticate(cliHeaders)).isErr()).toBe(true);
    expect((await authenticate(candidate.headers)).isErr()).toBe(true);
  });

  it("keeps an owner during concurrent demotions and exposes no organization lifecycle", async () => {
    const [first] = await environment.database.db
      .select()
      .from(member)
      .where(eq(member.role, "owner"));

    if (!first) throw new Error("Expected owner");

    const firstHeaders = new Headers(
      (await environment.users.login({ userId: first.userId })).headers,
    );

    firstHeaders.set("origin", environment.configuration.PLATFORM_URL);
    expect((await role(firstHeaders, first.id, "member")).status).toBe(400);
    const second = await person("Second Owner");
    expect((await role(firstHeaders, second.membership.id, "owner")).status).toBe(200);

    const demotions = await Promise.all([
      role(firstHeaders, first.id, "member"),
      role(second.headers, second.membership.id, "member"),
    ]);

    expect(demotions.filter((response) => response.ok)).toHaveLength(1);

    const owners = await environment.database.db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, installationOrganizationId), eq(member.role, "owner")));

    expect(owners).toHaveLength(1);

    for (const path of ["create", "delete", "leave", "remove-member", "invite-member"])
      expect(
        (await post(path, firstHeaders, { organizationId: installationOrganizationId })).status,
      ).toBe(404);
  });

  it("searches names and email addresses without treating input as SQL wildcards", async () => {
    const searched = await person("Searchable Person");
    expect(await findMembers(environment.database.db, "SEARCHABLE")).toEqual([
      expect.objectContaining({ userId: searched.record.id }),
    ]);
    expect(await findMembers(environment.database.db, searched.record.email)).toEqual([
      expect.objectContaining({ userId: searched.record.id }),
    ]);
    expect(await findMembers(environment.database.db, "%")).toEqual([]);
  });
});
