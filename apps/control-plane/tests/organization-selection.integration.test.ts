import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "@platform/contracts";
import { and, eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { member, organization, session } from "../src/lib/server/auth-schema.ts";
import { apps, fleets } from "../src/lib/server/schema.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";

describe("Organization discovery and selection", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let runtime: Awaited<ReturnType<ReturnType<typeof createRuntime>>>;
  let api: ReturnType<typeof createApi>;
  let headers: Headers;
  let userId: string;
  const alpha = crypto.randomUUID();
  const beta = crypto.randomUUID();
  const hidden = crypto.randomUUID();
  const admitted = new Set<string>();

  const request = (path: string, options: RequestInit = {}) =>
    new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, { headers, ...options });

  const accessToken = async (scope: string) => {
    const now = Math.floor(Date.now() / 1000);

    return runtime.auth.api.signJWT({
      body: {
        payload: {
          sub: userId,
          aud: `${environment.configuration.PLATFORM_URL}/api/v1`,
          iss: `${environment.configuration.PLATFORM_URL}/api/auth`,
          iat: now,
          exp: now + 300,
          scope,
        },
      },
    });
  };

  beforeAll(async () => {
    environment = await createTestEnvironment();

    const person = environment.users.createUser({
      name: "Switcher",
      email: "switcher@example.test",
    });

    userId = person.id;
    await environment.users.saveUser(person);
    headers = new Headers((await environment.users.login({ userId })).headers);
    headers.set("origin", environment.configuration.PLATFORM_URL);
    headers.set("content-type", "application/json");

    for (const [id, name] of [
      [alpha, "Alpha"],
      [beta, "Beta"],
      [hidden, "Hidden"],
    ]) {
      if (!id || !name) throw new Error("Incomplete organization fixture");
      await environment.database.db
        .insert(organization)
        .values({ id, name, slug: name.toLowerCase(), createdAt: new Date() });
      const fleetId = crypto.randomUUID();
      await environment.database.db.insert(fleets).values({
        id: fleetId,
        organizationId: id,
        name: id,
        appDomain: `${name.toLowerCase()}.example.test`,
      });
      admitted.add(fleetId);

      if (id !== hidden)
        await environment.database.db.insert(member).values({
          id: crypto.randomUUID(),
          userId,
          organizationId: id,
          role: id === alpha ? "admin" : "member",
          createdAt: new Date(),
        });
    }

    runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      reporting: environment.reporting,
      storage: createStorage(environment.configuration),
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
      // Returning an unrelated admitted ID must not turn it into a membership.
      fleetAccess: { filterFleets: async () => [...admitted] },
    })();
    api = createApi(runtime);
  });

  beforeEach(async () => {
    const records = await environment.database.db.select().from(fleets);
    admitted.clear();

    for (const record of records) admitted.add(record.id);
    headers.delete("x-widefleet-organization");
    await environment.database.db
      .update(session)
      .set({ activeOrganizationId: null })
      .where(eq(session.userId, userId));
    await environment.database.db
      .insert(member)
      .values({
        id: crypto.randomUUID(),
        userId,
        organizationId: beta,
        role: "member",
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await environment.close();
  });

  it("discovers only memberships before a selection exists, and requires authentication", async () => {
    expect((await api(request("/apps"))).status).toBe(403);
    expect(await (await api(request("/apps"))).json()).toMatchObject({
      code: "ORGANIZATION_REQUIRED",
    });
    const result = await api(request("/organizations"));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual([
      { id: alpha, name: "Alpha", slug: "alpha", role: "admin" },
      { id: beta, name: "Beta", slug: "beta", role: "member" },
    ]);
    expect((await api(request("/organizations", { headers: {} }))).status).toBe(401);
  });

  it.each(["session", "token"])(
    "automatically uses the only admitted organization for %s reads and writes",
    async (authentication) => {
      const [fleet] = await environment.database.db
        .select()
        .from(fleets)
        .where(eq(fleets.organizationId, alpha));

      if (!fleet) throw new Error("Missing organization fixture fleet");
      admitted.clear();
      admitted.add(fleet.id);
      const selectedHeaders = new Headers(headers);

      if (authentication === "token") {
        selectedHeaders.delete("cookie");
        const { token } = await accessToken("platform:read platform:write");
        selectedHeaders.set("authorization", `Bearer ${token}`);
      }

      expect(await (await api(request("/me", { headers: selectedHeaders }))).json()).toMatchObject({
        admin: false,
        application: { organizationId: alpha, admin: true },
      });

      const created = await api(
        request(`/apps/by-name/automatic-${authentication}`, {
          method: "PUT",
          headers: selectedHeaders,
          body: "{}",
        }),
      );

      expect(created.ok).toBe(true);
      const createdApp = app.parse(await created.json());

      try {
        expect(createdApp.hostname).toBe(`automatic-${authentication}.alpha.example.test`);

        for (const organizationId of [beta, hidden, "unknown", ""]) {
          selectedHeaders.set("x-widefleet-organization", organizationId);
          expect((await api(request("/apps", { headers: selectedHeaders }))).status).toBe(403);
        }
      } finally {
        await environment.database.db.delete(apps).where(eq(apps.id, createdApp.id));
      }
    },
  );

  it("rejects a stale browser write when the automatically available organization changes", async () => {
    const records = await environment.database.db.select().from(fleets);
    const alphaFleet = records.find((record) => record.organizationId === alpha);
    const betaFleet = records.find((record) => record.organizationId === beta);

    if (!alphaFleet || !betaFleet) throw new Error("Missing organization fixture fleets");
    admitted.clear();
    admitted.add(alphaFleet.id);
    expect(
      (await runtime.identity.authenticate(request("/apps"), "platform:write", alpha)).isOk(),
    ).toBe(true);
    admitted.clear();
    admitted.add(betaFleet.id);
    expect(
      await runtime.identity.authenticate(request("/apps"), "platform:write", alpha),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    admitted.clear();
    expect((await api(request("/apps"))).status).toBe(403);
  });

  it("only automatically selects organizations with one available fleet", async () => {
    const fleetId = crypto.randomUUID();
    await environment.database.db.insert(fleets).values({
      id: fleetId,
      name: fleetId,
      organizationId: beta,
    });
    admitted.add(fleetId);

    try {
      expect(await (await api(request("/organizations"))).json()).toEqual([
        { id: alpha, name: "Alpha", slug: "alpha", role: "admin" },
      ]);
      expect(await (await api(request("/me"))).json()).toMatchObject({
        application: { organizationId: alpha },
      });
      headers.set("x-widefleet-organization", beta);
      expect((await api(request("/me"))).status).toBe(403);
    } finally {
      await environment.database.db.delete(fleets).where(eq(fleets.id, fleetId));
      admitted.delete(fleetId);
    }
  });

  it("persists a browser selection and scopes same-named app operations after switching", async () => {
    const select = (organizationId: string) =>
      api(request("/organization", { method: "PUT", body: JSON.stringify({ organizationId }) }));

    expect((await select(alpha)).status).toBe(200);
    expect(
      (await runtime.identity.authenticate(request("/me"), "platform:read")).unwrap(),
    ).toMatchObject({ admin: false, application: { organizationId: alpha, admin: true } });
    const input = { slug: "shared-name", displayName: "Shared name", parentId: null };

    const a = app.parse(
      await (await api(request("/apps", { method: "POST", body: JSON.stringify(input) }))).json(),
    );

    expect(a).toMatchObject({ hostname: "shared-name.alpha.example.test" });
    expect((await select(beta)).status).toBe(200);

    const b = app.parse(
      await (await api(request("/apps", { method: "POST", body: JSON.stringify(input) }))).json(),
    );

    expect(b).toMatchObject({ hostname: "shared-name.beta.example.test" });
    expect(await (await api(request("/apps"))).json()).toEqual([b]);
    headers.set("x-widefleet-organization", alpha);
    expect(await (await api(request("/apps"))).json()).toEqual([a]);
    headers.delete("x-widefleet-organization");
  });

  it("rejects a stale browser organization before issuing a write principal", async () => {
    await runtime.identity.selectOrganization(request("/organization"), alpha);
    expect(
      (await runtime.identity.authenticate(request("/apps"), "platform:write", alpha)).isOk(),
    ).toBe(true);
    await runtime.identity.selectOrganization(request("/organization"), beta);

    const stale = await runtime.identity.authenticate(request("/apps"), "platform:write", alpha);
    expect(stale.isErr()).toBe(true);

    if (stale.isErr()) {
      expect(stale.error).toMatchObject({ code: "CONFLICT" });
      expect(stale.error.message).toContain("Reload this page");
    }

    expect(
      (await runtime.identity.authenticate(request("/apps"), "platform:write", beta)).unwrap()
        .application.organizationId,
    ).toBe(beta);
    expect(
      (await runtime.identity.authenticate(request("/apps"), "platform:write", "")).isErr(),
    ).toBe(true);
    await environment.database.db
      .delete(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, beta)));
    expect(
      (await runtime.identity.authenticate(request("/apps"), "platform:write", beta)).isErr(),
    ).toBe(true);
  });

  it("rejects foreign selections and cross-origin changes without replacing the current selection", async () => {
    await runtime.identity.selectOrganization(request("/organization"), beta);

    for (const organizationId of [hidden, "unknown", ""]) {
      const response = await api(
        request("/organization", { method: "PUT", body: JSON.stringify({ organizationId }) }),
      );

      expect(response.status).toBe(organizationId ? 403 : 400);
    }

    const foreignOrigin = new Headers(headers);
    foreignOrigin.set("origin", "https://foreign.example.test");
    expect(
      (
        await api(
          request("/organization", {
            method: "PUT",
            headers: foreignOrigin,
            body: JSON.stringify({ organizationId: alpha }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await runtime.identity.authenticate(request("/me"), "platform:read")).unwrap().application
        .organizationId,
    ).toBe(beta);
    headers.set("x-widefleet-organization", hidden);
    expect((await api(request("/apps"))).status).toBe(403);
    headers.delete("x-widefleet-organization");
  });

  it("rechecks admission and membership without silently selecting another organization", async () => {
    await runtime.identity.selectOrganization(request("/organization"), beta);
    await environment.database.db
      .delete(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, beta)));
    expect((await api(request("/apps"))).status).toBe(403);
    expect(await (await api(request("/organizations"))).json()).toEqual([
      { id: alpha, name: "Alpha", slug: "alpha", role: "admin" },
    ]);
    admitted.clear();
    expect(await (await api(request("/organizations"))).json()).toEqual([]);
    expect(
      (
        await api(
          request("/organization", {
            method: "PUT",
            body: JSON.stringify({ organizationId: alpha }),
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("honors token scopes during discovery and selection, independently of browser selection", async () => {
    const { token } = await accessToken("platform:read");
    const tokenHeaders = { authorization: `Bearer ${token}` };
    expect((await api(request("/organizations", { headers: tokenHeaders }))).status).toBe(200);
    expect(
      (
        await api(
          request("/organization", {
            method: "PUT",
            headers: { ...tokenHeaders, "content-type": "application/json" },
            body: JSON.stringify({ organizationId: alpha }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      await (
        await api(
          request("/me", { headers: { ...tokenHeaders, "x-widefleet-organization": alpha } }),
        )
      ).json(),
    ).toMatchObject({ application: { organizationId: alpha, admin: true } });
    expect((await api(request("/me", { headers: tokenHeaders }))).status).toBe(403);
  });

  it.runIf(process.env["RUN_CLI_TESTS"] === "1")(
    "uses the real CLI to discover organizations and select API access per command",
    async () => {
      const { token } = await accessToken("platform:read platform:write");
      const fixtureHeaders = new Headers(headers);
      fixtureHeaders.set("x-widefleet-organization", alpha);

      const created = await api(
        request("/apps/by-name/cli-selection", {
          method: "PUT",
          headers: fixtureHeaders,
          body: "{}",
        }),
      );

      expect(created.ok).toBe(true);
      const fixture = app.parse(await created.json());

      const server = createServer((incoming, outgoing) => {
        const forwarded = new Headers();

        for (const [key, value] of Object.entries(incoming.headers))
          if (value !== undefined)
            forwarded.set(key, Array.isArray(value) ? value.join(", ") : value);
        void api(request(incoming.url?.replace("/api/v1", "") ?? "/", { headers: forwarded }))
          .then(async (response) => {
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
          })
          .catch(() => outgoing.writeHead(500).end());
      });

      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = z.object({ port: z.number() }).parse(server.address());

      const options = {
        env: {
          ...process.env,
          PLATFORM_URL: `http://127.0.0.1:${address.port}`,
          PLATFORM_ACCESS_TOKEN: token,
          PLATFORM_USAGE_REPORTING: "false",
          PLATFORM_CRASH_REPORTING: "false",
        },
      };

      const execute = promisify(execFile);

      const binary =
        process.env["CLI_BINARY"] ??
        fileURLToPath(
          new URL(
            `../../../target/debug/${process.platform === "win32" ? "widefleet.exe" : "widefleet"}`,
            import.meta.url,
          ),
        );

      try {
        const choices = await execute(binary, ["organizations"], options);
        expect(
          z
            .array(z.object({ id: z.string() }))
            .parse(JSON.parse(choices.stdout))
            .map((choice) => choice.id),
        ).toEqual([alpha, beta]);

        for (const [id, admin] of [
          [alpha, true],
          [beta, false],
        ] as const) {
          const selected = await execute(binary, ["--organization", id, "whoami"], options);
          expect(JSON.parse(selected.stdout)).toMatchObject({
            admin: false,
            application: { organizationId: id, admin },
          });
        }

        const selected = await execute(binary, ["whoami"], {
          env: { ...options.env, PLATFORM_ORGANIZATION: beta },
        });

        expect(JSON.parse(selected.stdout)).toMatchObject({
          application: { organizationId: beta },
        });
        await expect(
          execute(binary, ["--organization", hidden, "apps"], options),
        ).rejects.toMatchObject({ code: 1, stdout: "" });
        await expect(execute(binary, ["apps"], options)).rejects.toMatchObject({
          code: 1,
          stdout: "",
        });
        await environment.database.db
          .delete(member)
          .where(and(eq(member.userId, userId), eq(member.organizationId, beta)));
        const automatic = await execute(binary, ["whoami"], options);
        expect(JSON.parse(automatic.stdout)).toMatchObject({
          application: { organizationId: alpha, admin: true },
        });
        const listed = await execute(binary, ["apps"], options);
        expect(z.array(app).parse(JSON.parse(listed.stdout))).toContainEqual(fixture);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await environment.database.db.delete(apps).where(eq(apps.id, fixture.id));
      }
    },
  );

  it("keeps default installations restricted to their own fleet even for multi-organization users", async () => {
    const identity = createIdentityService(
      environment.auth,
      environment.database.db,
      environment.configuration,
    );

    expect((await identity.organizations(request("/organizations"))).unwrap()).toEqual([]);
    headers.set("x-widefleet-organization", alpha);
    expect(await identity.authenticate(request("/me"), "platform:read")).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    headers.delete("x-widefleet-organization");
  });
});
