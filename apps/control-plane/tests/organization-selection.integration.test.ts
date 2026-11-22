import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "@platform/contracts";
import { and, eq, or } from "drizzle-orm";
import { esbuildBinary } from "../../../tools/cli-tools.ts";
import { CreateBucketCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { createS3Client, createS3Storage } from "../src/lib/server/storage/s3.ts";
import { createTestEnvironment } from "./environment.ts";
import { member, organization, session } from "../src/lib/server/auth-schema.ts";
import { apps, organizationRuntimes } from "../src/lib/server/schema.ts";
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
          reference_id: `user:${userId}`,
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
    environment.configuration.S3_BUCKET = `test-${crypto.randomUUID()}`;

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
      const organizationId = id;
      await environment.database.db.insert(organizationRuntimes).values({
        organizationId: id,
        appHostnameSuffix: name.toLowerCase(),
      });
      admitted.add(organizationId);

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
      organizationAccess: { filterOrganizations: async () => [...admitted] },
    })();
    api = createApi(runtime);
  });

  beforeEach(async () => {
    const records = await environment.database.db.select().from(organizationRuntimes);
    admitted.clear();

    for (const record of records) admitted.add(record.organizationId);
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
      { id: alpha, name: "Alpha", slug: "alpha", role: "admin", ssoRequired: false },
      { id: beta, name: "Beta", slug: "beta", role: "member", ssoRequired: false },
    ]);
    expect((await api(request("/organizations", { headers: {} }))).status).toBe(401);
  });

  it.each(["session", "token"])(
    "automatically uses the only admitted organization for %s reads and writes",
    async (authentication) => {
      const [execution] = await environment.database.db
        .select()
        .from(organizationRuntimes)
        .where(eq(organizationRuntimes.organizationId, alpha));

      if (!execution) throw new Error("Missing organization fixture execution");
      admitted.clear();
      admitted.add(execution.organizationId);
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
        expect(createdApp.hostname).toBe(`automatic-${authentication}-alpha.apps.localhost`);

        for (const organizationId of [beta, hidden, "unknown", ""]) {
          selectedHeaders.set("x-widefleet-organization", organizationId);
          expect((await api(request("/apps", { headers: selectedHeaders }))).status).toBe(403);
        }
      } finally {
        await environment.database.db.delete(apps).where(eq(apps.id, createdApp.id));
      }
    },
  );

  it("requires the header once a second organization becomes available", async () => {
    admitted.clear();
    admitted.add(alpha);
    expect((await api(request("/me"))).status).toBe(200);
    admitted.add(beta);
    expect(await (await api(request("/me"))).json()).toMatchObject({
      code: "ORGANIZATION_REQUIRED",
    });
  });

  it("ignores an organization stored on the browser session", async () => {
    // Better Auth's organization plugin keeps this column; Widefleet never reads it.
    await environment.database.db
      .update(session)
      .set({ activeOrganizationId: beta })
      .where(eq(session.userId, userId));
    expect(await (await api(request("/me"))).json()).toMatchObject({
      code: "ORGANIZATION_REQUIRED",
    });
    expect((await api(request("/organization", { method: "PUT", body: "{}" }))).status).toBe(404);
  });

  it("rejects a page's organization once it becomes unavailable", async () => {
    const page = () =>
      runtime.identity.member(
        { userId, identityOrganizationId: null, recovery: false },
        { organizationSlug: "alpha" },
      );

    expect((await page()).isOk()).toBe(true);
    admitted.delete(alpha);
    expect(await page()).toMatchObject({ error: { code: "FORBIDDEN" } });
    admitted.clear();
    expect((await api(request("/apps"))).status).toBe(403);
  });

  it("allows only one execution configuration per organization", async () => {
    await expect(
      environment.database.db.insert(organizationRuntimes).values({ organizationId: beta }),
    ).rejects.toThrow();
    expect((await api(request("/organizations"))).status).toBe(200);
  });

  it("scopes same-named app operations to the organization each request names", async () => {
    const input = { slug: "shared-name", displayName: "Shared name", parentId: null };

    const create = async (organizationId: string) => {
      headers.set("x-widefleet-organization", organizationId);

      return app.parse(
        await (await api(request("/apps", { method: "POST", body: JSON.stringify(input) }))).json(),
      );
    };

    const a = await create(alpha);
    expect(a).toMatchObject({ hostname: "shared-name-alpha.apps.localhost" });
    const b = await create(beta);
    expect(b).toMatchObject({ hostname: "shared-name-beta.apps.localhost" });
    expect(await (await api(request("/apps"))).json()).toEqual([
      { ...b, source: { supported: false, branch: "main", deployed: null } },
    ]);
    headers.set("x-widefleet-organization", alpha);
    expect(await (await api(request("/apps"))).json()).toEqual([
      { ...a, source: { supported: false, branch: "main", deployed: null } },
    ]);
    headers.delete("x-widefleet-organization");
  });

  it("resolves the organization a page names", async () => {
    const page = (organizationSlug: string) =>
      runtime.identity.member(
        { userId, identityOrganizationId: null, recovery: false },
        { organizationSlug },
      );

    expect((await page("beta")).unwrap()).toMatchObject({
      principal: { application: { organizationId: beta, admin: false } },
      organization: { id: beta, name: "Beta", slug: "beta" },
    });
    expect(
      (
        await runtime.identity.member(
          { userId, identityOrganizationId: null, recovery: false },
          { organizationId: beta },
        )
      ).isOk(),
    ).toBe(true);

    for (const slug of ["hidden", "unknown", ""])
      expect(await page(slug)).toMatchObject({ error: { code: "FORBIDDEN" } });

    await environment.database.db
      .delete(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, beta)));
    expect(await page("beta")).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("rejects foreign organizations and cross-origin writes", async () => {
    for (const organizationId of [hidden, "unknown", ""]) {
      headers.set("x-widefleet-organization", organizationId);
      expect((await api(request("/apps"))).status).toBe(403);
    }

    headers.set("x-widefleet-organization", alpha);
    const foreignOrigin = new Headers(headers);
    foreignOrigin.set("origin", "https://foreign.example.test");
    expect(
      (
        await api(
          request("/apps", {
            method: "POST",
            headers: foreignOrigin,
            body: JSON.stringify({ slug: "foreign", displayName: "Foreign", parentId: null }),
          }),
        )
      ).status,
    ).toBe(403);
    headers.delete("x-widefleet-organization");
  });

  it("rechecks admission and membership without silently selecting another organization", async () => {
    headers.set("x-widefleet-organization", beta);
    await environment.database.db
      .delete(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, beta)));
    expect((await api(request("/apps"))).status).toBe(403);
    headers.delete("x-widefleet-organization");
    expect(await (await api(request("/organizations"))).json()).toEqual([
      { id: alpha, name: "Alpha", slug: "alpha", role: "admin", ssoRequired: false },
    ]);
    admitted.clear();
    expect(await (await api(request("/organizations"))).json()).toEqual([]);
  });

  it("honors token scopes during discovery and selection", async () => {
    const { token } = await accessToken("platform:read");
    const tokenHeaders = { authorization: `Bearer ${token}` };
    expect((await api(request("/organizations", { headers: tokenHeaders }))).status).toBe(200);
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
    "uses the real CLI to select an organization, deploy and reuse flat previews",
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

      const started = Date.now();
      const events: string[] = [];
      const trace = (event: string) => events.push(`${Date.now() - started}ms ${event}`);

      const server = createServer((incoming, outgoing) => {
        const port = incoming.socket.remotePort;
        const description = `${port} ${incoming.method} ${incoming.url}`;
        trace(`request ${description}`);
        outgoing.once("finish", () => trace(`response ${description}: ${outgoing.statusCode}`));

        const handle = async () => {
          const forwarded = new Headers();

          for (const [key, value] of Object.entries(incoming.headers))
            if (value !== undefined)
              forwarded.set(key, Array.isArray(value) ? value.join(", ") : value);
          const chunks: Uint8Array[] = [];

          for await (const chunk of incoming) chunks.push(z.instanceof(Uint8Array).parse(chunk));

          const response = await api(
            request(incoming.url?.replace("/api/v1", "") ?? "/", {
              method: incoming.method ?? "GET",
              headers: forwarded,
              body: chunks.length ? Buffer.concat(chunks) : null,
            }),
          );

          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        };

        void handle().catch((cause: unknown) => {
          trace(`handler failed: ${String(cause)}`);
          outgoing.writeHead(500).end();
        });
      });

      server.on("connection", (socket) => {
        const port = socket.remotePort;
        trace(`connected ${port}`);
        socket.on("timeout", () => trace(`timeout ${port}`));
        socket.on("close", (hadError) => trace(`closed ${port}, error=${hadError}`));
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

      const directory = await mkdtemp(join(tmpdir(), "widefleet-organization-cli-"));
      const s3 = createS3Client(environment.configuration);
      const objects = createS3Storage(environment.configuration, s3);

      try {
        await s3.send(new CreateBucketCommand({ Bucket: environment.configuration.S3_BUCKET }));
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
        expect(z.array(app).parse(JSON.parse(listed.stdout))).toContainEqual({
          ...fixture,
          source: { supported: false, branch: "main", deployed: null },
        });

        const executableName = process.platform === "win32" ? "widefleet.exe" : "widefleet";
        const installed = join(directory, executableName);
        const esbuild = esbuildBinary();
        await copyFile(binary, installed);
        await copyFile(
          esbuild,
          join(directory, process.platform === "win32" ? "esbuild.exe" : "esbuild"),
        );

        const version = (await execute(binary, ["--version"])).stdout
          .trim()
          .replace(/^widefleet /, "");

        const esbuildVersion = (await execute(esbuild, ["--version"])).stdout.trim();
        await writeFile(
          join(directory, "release.json"),
          JSON.stringify({
            format: 1,
            version,
            esbuild_version: esbuildVersion,
          }),
        );
        await mkdir(join(directory, "public"));
        await writeFile(
          join(directory, "worker.js"),
          'export default { fetch() { return new Response("fixture"); } };',
        );
        await writeFile(
          join(directory, "wrangler.jsonc"),
          JSON.stringify({
            name: fixture.slug,
            main: "worker.js",
            compatibility_date: "2026-10-01",
            assets: { directory: "public", binding: "ASSETS" },
          }),
        );

        const deployment = await execute(
          installed,
          ["deploy", "--skip-build", "--no-wait", "--json"],
          { ...options, cwd: directory },
        );

        expect(JSON.parse(deployment.stdout)).toMatchObject({
          appId: fixture.id,
          status: "queued",
          url: "https://cli-selection-alpha.apps.localhost/",
        });
        let previewId: string | undefined;

        for (const selection of [[], ["--organization", alpha]]) {
          const result = await execute(
            installed,
            [...selection, "preview", "--name", "review", "--skip-build", "--no-wait", "--json"],
            { ...options, cwd: directory },
          );

          const preview = z
            .object({ appId: z.string(), url: z.string(), status: z.string() })
            .parse(JSON.parse(result.stdout));

          expect(preview).toMatchObject({
            status: "queued",
            url: "https://review-cli-selection-alpha.apps.localhost/",
          });

          if (previewId) expect(preview.appId).toBe(previewId);
          previewId = preview.appId;
          expect(
            app.parse(
              await (
                await api(request(`/apps/${preview.appId}`, { headers: fixtureHeaders }))
              ).json(),
            ),
          ).toMatchObject({
            parentId: fixture.id,
            organizationId: fixture.organizationId,
            hostname: "review-cli-selection-alpha.apps.localhost",
          });
        }
      } catch (cause) {
        console.error(`Local API requests and connections:\n${events.join("\n")}`);
        throw cause;
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await environment.database.db
          .delete(apps)
          .where(or(eq(apps.id, fixture.id), eq(apps.parentId, fixture.id)));
        await rm(directory, { recursive: true, force: true });
        const keys = [];

        for await (const object of objects.list("")) keys.push(object.key);

        if (keys.length) await objects.remove(keys);
        await s3.send(new DeleteBucketCommand({ Bucket: environment.configuration.S3_BUCKET }));
        s3.destroy();
      }
    },
    30_000,
  );

  it("keeps default installations restricted to their own execution even for multi-organization users", async () => {
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
