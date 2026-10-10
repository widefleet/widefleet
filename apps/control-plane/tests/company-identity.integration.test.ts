import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { and, eq, sql } from "drizzle-orm";
import { account } from "../src/lib/server/auth-schema.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createAppAccessService } from "../src/lib/server/app-access.ts";
import { providerIssuer } from "../src/lib/server/company-identity.ts";
import { appActions } from "../src/lib/server/app-permissions.ts";
import { apps } from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";

describe("Management company groups with Better Auth", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await environment.close();
  });

  const fixture = async () => {
    const user = environment.users.createUser({
      name: "Group Member",
      email: `${crypto.randomUUID()}@example.test`,
    });

    await environment.users.saveUser(user);
    const subject = crypto.randomUUID();
    const group = crypto.randomUUID();
    await environment.linkMicrosoftUser(user.id, subject);
    const provider = providerIssuer(environment.configuration.IDENTITY.provider);
    const expiresAt = Math.floor(Date.now() / 1000) * 1000 + 600_000;
    // Trusted stored-account fixture: authentication below still uses real Better Auth sessions and token lookup.
    const idToken = `${Buffer.from('{"alg":"fixture"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: provider, tid: "00000000-0000-4000-8000-000000000001", sub: "client-specific", oid: subject, exp: expiresAt / 1000, hasgroups: true })).toString("base64url")}.fixture`;
    await environment.database.db
      .update(account)
      .set({
        idToken,
        accessToken: "delegated-member-token",
        accessTokenExpiresAt: new Date(expiresAt + 600_000),
      })
      .where(eq(account.userId, user.id));
    await environment.database.db.insert(account).values({
      id: crypto.randomUUID(),
      userId: user.id,
      accountId: "another-account",
      providerId: "unrelated-provider",
      accessToken: "wrong-provider-token",
      accessTokenExpiresAt: new Date(expiresAt + 600_000),
    });
    const session = await environment.users.login({ userId: user.id });

    const request = new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps`, {
      headers: session.headers,
    });

    const admin = {
      ...environment.owner,
      admin: true,
      creator: true,
      role: "owner" as const,
      company: undefined,
    };

    const service = createAppService(environment.database.db, environment.configuration);
    const access = createAppAccessService(environment.database.db, environment.configuration);

    const app = (
      await service.create(admin, {
        slug: `groups-${crypto.randomUUID()}`,
        displayName: "Groups",
        parentId: null,
      })
    ).unwrap();

    (
      await access.transfer(admin, app.id, {
        revision: 1,
        principal: { type: "group", provider, subject: group },
      })
    ).unwrap();

    return { request, app, access, admin, provider, group, user, expiresAt };
  };

  it("shares token-bound lookups and reuses memberships when app assignments change", async () => {
    const context = await fixture();
    let lookups = 0;

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
      async (input, options) => {
        const request = new Request(input, options);
        expect(request.url).toBe(
          "https://graph.microsoft.com/v1.0/me/transitiveMemberOf?$select=id&$top=999",
        );
        expect(request.headers.get("authorization")).toBe("Bearer delegated-member-token");
        lookups += 1;

        return Response.json({
          value: [{ id: context.group, "@odata.type": "#microsoft.graph.group" }],
        });
      },
    );

    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => identity.authenticate(context.request, "platform:read")),
    );

    const principal = concurrent[0]?.unwrap();

    if (!principal) throw new Error("No authenticated principal");

    for (const result of concurrent)
      expect(result.unwrap().company?.groups).toEqual([context.group]);
    expect(lookups).toBe(1);
    expect(principal.company?.groups).toEqual([context.group]);
    expect(await appActions(environment.database.db, principal, context.app.id)).toContain(
      "transfer",
    );
    (await identity.authenticate(context.request, "platform:read")).unwrap();
    expect(lookups).toBe(1);
    (
      await context.access.grant(context.admin, context.app.id, {
        revision: 2,
        role: "user",
        principal: { type: "group", provider: context.provider, subject: crypto.randomUUID() },
      })
    ).unwrap();
    (await identity.authenticate(context.request, "platform:read")).unwrap();
    expect(lookups).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(context.expiresAt + 1);
    const expired = (await identity.authenticate(context.request, "platform:read")).unwrap();
    expect(expired.company).toMatchObject({ groups: [], groupsExpired: true });
    expect(lookups).toBe(1);
    expect(await appActions(environment.database.db, principal, context.app.id)).not.toContain(
      "transfer",
    );
  });

  it("discards a Graph result when the originating token expires during lookup", async () => {
    const context = await fixture();

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
      async () => {
        vi.spyOn(Date, "now").mockReturnValue(context.expiresAt + 1);

        return Response.json({
          value: [{ id: context.group, "@odata.type": "#microsoft.graph.group" }],
        });
      },
    );

    expect(
      (await identity.authenticate(context.request, "platform:read")).unwrap().company,
    ).toMatchObject({ groups: [], groupsExpired: true });
  });

  it("rejects group ownership transfer after waiting past expiry for the app lock", async () => {
    const context = await fixture();

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
      async () =>
        Response.json({ value: [{ id: context.group, "@odata.type": "#microsoft.graph.group" }] }),
    );

    const principal = (await identity.authenticate(context.request, "platform:read")).unwrap();
    const locks = new EventEmitter();
    const locked = once(locks, "locked");
    const released = once(locks, "released");

    const holding = environment.database.db.transaction(async (transaction) => {
      await transaction.select().from(apps).where(eq(apps.id, context.app.id)).for("update");
      locks.emit("locked");
      await released;
    });

    await locked;

    const transfer = context.access.transfer(principal, context.app.id, {
      revision: 2,
      principal: { type: "user", provider: context.provider, subject: "replacement" },
    });

    try {
      await vi.waitFor(async () => {
        const blocked = await environment.database.db.execute(
          sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        );

        expect(blocked.rows.length).toBeGreaterThan(0);
      });
      vi.spyOn(Date, "now").mockReturnValue(context.expiresAt + 1);
    } finally {
      locks.emit("released");
      await holding;
    }

    expect(await transfer).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("fails closed when delegated membership lookup fails", async () => {
    const context = await fixture();

    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
      async () => new Response(null, { status: 403 }),
    );

    expect((await identity.authenticate(context.request, "platform:read")).isErr()).toBe(true);
    await environment.database.db
      .update(account)
      .set({ accessToken: null })
      .where(and(eq(account.userId, context.user.id), eq(account.providerId, "microsoft")));
    expect((await identity.authenticate(context.request, "platform:read")).isErr()).toBe(true);
  });
});
