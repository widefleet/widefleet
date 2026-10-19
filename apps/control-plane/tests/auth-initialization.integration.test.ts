import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiResource, cliClientId, cliScopes } from "../src/lib/server/auth-options.ts";
import { oauthClient, oauthClientResource, oauthResource } from "../src/lib/server/auth-schema.ts";
import { createAuthentication, registerCli } from "../src/lib/server/auth.ts";
import { createTestEnvironment } from "./environment.ts";
import { observeOAuthResourceWrites } from "./oauth-resource-writes.ts";

describe("Installation-owned CLI resource policy", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

  beforeEach(async () => {
    environment = await createTestEnvironment();
  });
  afterEach(async () => {
    await environment.close();
  });

  const initialize = () => registerCli(environment.database.db, environment.configuration);

  const resource = () =>
    environment.database.db
      .select()
      .from(oauthResource)
      .where(eq(oauthResource.identifier, apiResource(environment.configuration)));

  it("initializes the resource and client together, including concurrent initialization", async () => {
    await environment.database.db.delete(oauthClient);
    await environment.database.db.delete(oauthResource);
    await Promise.all([initialize(), initialize()]);

    expect(await resource()).toMatchObject([
      { allowedScopes: cliScopes, accessTokenTtl: 300, disabled: false },
    ]);
    expect(await environment.database.db.select().from(oauthClient)).toMatchObject([
      { clientId: cliClientId, scopes: cliScopes },
    ]);
    expect(await environment.database.db.select().from(oauthClientResource)).toMatchObject([
      { clientId: cliClientId, resourceId: apiResource(environment.configuration) },
    ]);
  });

  it("updates earlier release policies while preserving the existing resource and client identities", async () => {
    const [previous] = await resource();
    const [client] = await environment.database.db.select().from(oauthClient);
    await environment.database.db.update(oauthResource).set({
      allowedScopes: ["platform:read", "obsolete:scope"],
      accessTokenTtl: 3600,
      refreshTokenTtl: 7200,
      customClaims: { obsolete: true },
      disabled: true,
    });
    await environment.database.db.update(oauthClient).set({ scopes: ["platform:read"] });
    await initialize();

    expect(await resource()).toEqual([
      expect.objectContaining({
        id: previous?.id,
        createdAt: previous?.createdAt,
        allowedScopes: cliScopes,
        accessTokenTtl: 300,
        refreshTokenTtl: null,
        customClaims: null,
        disabled: false,
      }),
    ]);
    expect(await environment.database.db.select().from(oauthClient)).toEqual([
      expect.objectContaining({ id: client?.id, scopes: cliScopes }),
    ]);
    expect(await environment.database.db.select().from(oauthClientResource)).toHaveLength(1);
  });

  it("does not register a client when its initial resource policy cannot be saved", async () => {
    await environment.database.db.delete(oauthClient);
    await environment.database.db.delete(oauthResource);
    await environment.database.db.execute(sql`
      CREATE FUNCTION fixture_reject_policy_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture policy insert failed'; END;
      $$;
      CREATE TRIGGER fixture_reject_policy_insert BEFORE INSERT ON oauth_resource
        FOR EACH ROW EXECUTE FUNCTION fixture_reject_policy_insert();
    `);

    await expect(initialize()).rejects.toThrow();
    expect(await resource()).toEqual([]);
    expect(await environment.database.db.select().from(oauthClient)).toEqual([]);
    expect(await environment.database.db.select().from(oauthClientResource)).toEqual([]);
  });

  it("rejects a silently skipped policy update before changing the CLI client", async () => {
    await environment.database.db.update(oauthResource).set({ accessTokenTtl: 3600 });
    await environment.database.db.update(oauthClient).set({ scopes: ["platform:read"] });
    await environment.database.db.execute(sql`
      CREATE FUNCTION fixture_skip_policy_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN OLD; END;
      $$;
      CREATE TRIGGER fixture_skip_policy_update BEFORE UPDATE ON oauth_resource
        FOR EACH ROW EXECUTE FUNCTION fixture_skip_policy_update();
    `);

    await expect(initialize()).rejects.toThrow("CLI resource policy was not initialized");
    expect(await resource()).toMatchObject([{ accessTokenTtl: 3600 }]);
    expect(await environment.database.db.select().from(oauthClient)).toMatchObject([
      { scopes: ["platform:read"] },
    ]);
  });

  it("rolls back the policy when the client registration fails, and allows a later retry", async () => {
    await environment.database.db.update(oauthResource).set({ accessTokenTtl: 3600 });
    const previous = await resource();
    await environment.database.db.execute(sql`
      CREATE FUNCTION fixture_reject_client_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture client update failed'; END;
      $$;
      CREATE TRIGGER fixture_reject_client_update BEFORE UPDATE ON oauth_client
        FOR EACH ROW EXECUTE FUNCTION fixture_reject_client_update();
    `);

    await expect(initialize()).rejects.toThrow();
    expect(await resource()).toEqual(previous);

    await environment.database.db.execute(
      sql`DROP TRIGGER fixture_reject_client_update ON oauth_client`,
    );
    await initialize();
    expect(await resource()).toMatchObject([{ accessTokenTtl: 300 }]);
  });

  it("does not write resource policies when separate auth instances check sessions", async () => {
    const session = await environment.users.login({ userId: environment.owner.id });
    const writes = await observeOAuthResourceWrites(environment.database.db);

    const sessions = await Promise.all(
      Array.from({ length: 3 }, () =>
        createAuthentication(environment.configuration, environment.database.db).api.getSession({
          headers: new Headers(session.headers),
        }),
      ),
    );

    for (const current of sessions) expect(current?.user.id).toBe(environment.owner.id);
    expect(await writes()).toBe(0);
  });

  it("rejects token requests for missing resource policies instead of recreating them", async () => {
    await environment.database.db.delete(oauthResource);
    const writes = await observeOAuthResourceWrites(environment.database.db);
    const auth = createAuthentication(environment.configuration, environment.database.db);

    const response = await auth.handler(
      new Request(`${environment.configuration.PLATFORM_URL}/api/auth/device/code`, {
        method: "POST",
        body: new URLSearchParams({
          client_id: cliClientId,
          scope: "openid platform:read",
          resource: apiResource(environment.configuration),
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_target" });
    expect(await resource()).toEqual([]);
    expect(await writes()).toBe(0);
  });
});
