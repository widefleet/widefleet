import { createWorkflowService } from "../src/lib/server/workflows.ts";
import { createMigrationService } from "../src/lib/server/migrations.ts";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApi } from "../src/lib/server/api.ts";
import { createAgentService } from "../src/lib/server/agents.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createConnectorService } from "../src/lib/server/connectors.ts";
import { createDirectory } from "../src/lib/server/directory.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createJobService } from "../src/lib/server/jobs.ts";
import { createAppAccessService } from "../src/lib/server/app-access.ts";
import { createNetworkService } from "../src/lib/server/network.ts";
import { createRuntimeReleaseService } from "../src/lib/server/runtime-releases.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createTelemetry } from "../src/lib/server/telemetry.ts";
import { createUploadService } from "../src/lib/server/uploads.ts";
import { createTestEnvironment } from "./environment.ts";

const execute = promisify(execFile);

const storedSession = z.object({
  origin: z.string(),
  expires_at: z.number(),
  tokens: z.object({
    access_token: z.string(),
    refresh_token: z.string(),
    expires_in: z.number(),
    token_type: z.string(),
  }),
});

describe.runIf(process.env["RUN_CLI_TESTS"] === "1" && process.platform !== "win32")(
  "Headless CLI with real OAuth and PostgreSQL",
  () => {
    let directory: string;
    let origin: string;
    let sessionFile: string;
    let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
    let api: ReturnType<typeof createApi>;
    let approvalHeaders: Headers;
    let failRevocation = false;
    let omitRefreshToken = false;
    let externalAccessToken: string | undefined;

    const requests: { path: string; body: URLSearchParams; origin: string; contentType: string }[] =
      [];

    const serverErrors: Error[] = [];

    const handle = async (request: Request) => {
      const path = new URL(request.url).pathname;
      const body = new URLSearchParams(await request.clone().text());
      requests.push({
        path,
        body,
        origin: request.headers.get("origin") ?? "",
        contentType: request.headers.get("content-type") ?? "",
      });

      if (path === "/api/auth/oauth2/revoke" && failRevocation)
        return new Response(null, { status: 503 });

      if (path === "/api/auth/oauth2/token" && omitRefreshToken)
        return Response.json({
          access_token: "synthetic-access-token-never-log",
          expires_in: 300,
          token_type: "Bearer",
        });

      if (!path.startsWith("/api/auth/")) return api(request);
      const response = await environment.auth.handler(request);

      if (path === "/api/auth/device/code" && response.ok) {
        const device = z.object({ user_code: z.string() }).parse(await response.clone().json());

        const claimed = await environment.auth.handler(
          new Request(`${origin}/api/auth/device?user_code=${device.user_code}`, {
            headers: approvalHeaders,
          }),
        );

        expect(claimed.status).toBe(200);

        const approved = await environment.auth.handler(
          new Request(`${origin}/api/auth/device/approve`, {
            method: "POST",
            headers: approvalHeaders,
            body: JSON.stringify({ userCode: device.user_code }),
          }),
        );

        expect(approved.status).toBe(200);
      }

      return response;
    };

    const server = createServer((incoming, outgoing) => {
      let body = "";
      incoming.setEncoding("utf8").on("data", (chunk: string) => {
        body += chunk;
      });
      incoming.on("end", () => {
        const headers = new Headers();

        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }

        const options: RequestInit = { method: incoming.method ?? "GET", headers };

        if (incoming.method !== "GET" && incoming.method !== "HEAD") options.body = body;
        void handle(new Request(`${origin}${incoming.url ?? "/"}`, options))
          .then(async (response) => {
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
          })
          .catch((cause: unknown) => {
            serverErrors.push(cause instanceof Error ? cause : new Error("Local request failed"));
            outgoing.writeHead(500).end();
          });
      });
    });

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet-headless-cli-"));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
      environment = await createTestEnvironment(origin);
      const configuration = environment.configuration;
      const database = environment.database.db;
      const storage = createStorage(configuration);
      api = createApi({
        ...environment,
        storage,
        identity: createIdentityService(environment.auth, database, configuration),
        directory: createDirectory(configuration),
        apps: createAppService(database, configuration),
        agents: createAgentService(database),
        jobs: createJobService(database, storage, "local-integration-test-encryption-key-only"),
        network: createNetworkService(database),
        appAccess: createAppAccessService(database),
        workflows: createWorkflowService(database),
        migrations: createMigrationService(database, storage),
        connectors: createConnectorService(
          database,
          storage,
          "local-integration-test-encryption-key-only",
        ),
        releases: createRuntimeReleaseService(database, storage),
        uploads: createUploadService(database, storage, configuration),
        telemetry: createTelemetry(database, storage, configuration),
      });
      const user = environment.users.createUser({ email: "headless@example.test" });
      await environment.users.saveUser(user);
      await environment.linkMicrosoftUser(user.id, environment.ownerSubject);
      approvalHeaders = new Headers((await environment.users.login({ userId: user.id })).headers);
      approvalHeaders.set("origin", origin);
      approvalHeaders.set("content-type", "application/json");
    });

    beforeEach(() => {
      sessionFile = join(directory, crypto.randomUUID(), "session.json");
      requests.length = 0;
      failRevocation = false;
      omitRefreshToken = false;
      externalAccessToken = undefined;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await environment.close();
      await rm(directory, { recursive: true, force: true });
      expect(serverErrors).toEqual([]);
    });

    const cli = (...args: string[]) =>
      execute(
        process.env["CLI_BINARY"] ??
          fileURLToPath(new URL("../../../target/debug/widefleet", import.meta.url)),
        args,
        {
          timeout: 15000,
          env: {
            ...process.env,
            PLATFORM_URL: origin,
            PLATFORM_SESSION_FILE: sessionFile,
            PLATFORM_ACCESS_TOKEN: externalAccessToken,
            XDG_STATE_HOME: join(directory, "state"),
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(directory, "missing-bus")}`,
            NO_PROXY: "127.0.0.1",
            no_proxy: "127.0.0.1",
          },
        },
      );

    const failure = async (operation: ReturnType<typeof cli>) => {
      try {
        await operation;
      } catch (error) {
        return z.object({ code: z.number(), stdout: z.string(), stderr: z.string() }).parse(error);
      }

      throw new Error("Expected the CLI command to fail");
    };

    const readSession = async () =>
      storedSession.parse(JSON.parse(await readFile(sessionFile, "utf8")));

    it("logs in, calls the API, serializes refresh across processes and revokes the saved session", async () => {
      const login = await cli("login", "--scope", "platform:read");
      expect(login.stdout).toContain("stored unencrypted");
      const initial = await readSession();
      expect(initial.origin).toBe(origin);
      expect(initial.tokens.access_token.split(".")).toHaveLength(3);
      expect(login.stdout + login.stderr).not.toContain(initial.tokens.access_token);
      expect(login.stdout + login.stderr).not.toContain(initial.tokens.refresh_token);
      expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(sessionFile))).mode & 0o777).toBe(0o700);
      expect(requests[0]?.body.get("resource")).toBe(`${origin}/api/v1`);
      expect(requests[0]?.body.get("scope")?.split(" ")).toEqual([
        "openid",
        "profile",
        "offline_access",
        "platform:read",
      ]);
      expect(
        requests
          .filter(({ path }) => path.startsWith("/api/auth/"))
          .every(
            (request) =>
              request.origin === origin &&
              request.contentType === "application/x-www-form-urlencoded",
          ),
      ).toBe(true);
      expect(JSON.parse((await cli("whoami")).stdout)).toMatchObject({
        email: "headless@example.test",
      });
      expect(JSON.parse((await cli("apps")).stdout)).toEqual([]);
      await cli("connector", "list");

      await writeFile(sessionFile, JSON.stringify({ ...initial, expires_at: 0 }), { mode: 0o600 });
      const results = await Promise.all([cli("whoami"), cli("whoami"), cli("apps")]);
      expect(results).toHaveLength(3);
      const renewed = await readSession();
      expect(renewed.tokens.refresh_token).not.toBe(initial.tokens.refresh_token);
      const refreshes = requests.filter(({ body }) => body.get("grant_type") === "refresh_token");
      expect(refreshes).toHaveLength(1);
      expect(refreshes[0]?.body.get("resource")).toBe(`${origin}/api/v1`);
      expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);

      failRevocation = true;
      await expect(cli("logout")).rejects.toMatchObject({ code: 1 });
      expect(await readSession()).toEqual(renewed);
      failRevocation = false;
      await cli("logout");
      await expect(readFile(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await failure(cli("whoami"))).stderr).toContain("No session is stored");

      const revoked = await environment.auth.handler(
        new Request(`${origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { origin, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "platform-cli",
            grant_type: "refresh_token",
            refresh_token: renewed.tokens.refresh_token,
            resource: `${origin}/api/v1`,
          }),
        }),
      );

      expect(revoked.status).toBeGreaterThanOrEqual(400);
    }, 20000);

    it("honors the explicit file argument and refuses to send credentials to another origin", async () => {
      const chosen = join(directory, "explicit", "session.json");
      await cli("--session-file", chosen, "login", "--scope", "platform:read");
      await expect(readFile(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse((await cli("whoami", "--session-file", chosen)).stdout)).toMatchObject({
        email: "headless@example.test",
      });
      requests.length = 0;
      expect(
        (await failure(cli("--session-file", chosen, "--url", "http://127.0.0.1:1", "whoami")))
          .stderr,
      ).toContain("different platform");
      expect(requests).toEqual([]);
    }, 20000);

    it("rejects public directories, public files and symlinks before requesting credentials", async () => {
      const parent = dirname(sessionFile);
      await mkdir(parent, { recursive: true, mode: 0o755 });
      await chmod(parent, 0o755);
      expect((await failure(cli("login"))).stderr).toContain("chmod 700");
      await chmod(parent, 0o700);
      await writeFile(sessionFile, "sensitive-invalid-session", { mode: 0o644 });
      await chmod(sessionFile, 0o644);
      expect((await failure(cli("login"))).stderr).toContain("chmod 600");
      await rm(sessionFile);
      const target = join(parent, "target.json");
      await writeFile(target, "sensitive-invalid-session", { mode: 0o600 });
      await symlink(target, sessionFile);
      expect((await failure(cli("login"))).stderr).toContain("without symbolic or hard links");
      expect(await readFile(target, "utf8")).toBe("sensitive-invalid-session");
      await rm(sessionFile);
      await link(target, sessionFile);
      expect((await failure(cli("login"))).stderr).toContain("without symbolic or hard links");
      await rm(sessionFile);
      await writeFile(sessionFile, "sensitive-invalid-session", { mode: 0o600 });
      const malformed = await failure(cli("whoami"));
      expect(malformed.stderr).toContain("Invalid session file");
      expect(malformed.stderr).not.toContain("sensitive-invalid-session");
      await rm(`${sessionFile}.lock`);
      await symlink(target, `${sessionFile}.lock`);
      expect((await failure(cli("login"))).stderr).toContain("without symbolic or hard links");
      expect(requests).toEqual([]);
    });

    it("gives an external access token precedence without reading or creating the selected store", async () => {
      await cli("login", "--scope", "platform:read");
      externalAccessToken = (await readSession()).tokens.access_token;
      sessionFile = join(directory, "unused-store", "session.json");
      requests.length = 0;
      expect(JSON.parse((await cli("whoami")).stdout)).toMatchObject({
        email: "headless@example.test",
      });
      expect(requests.map(({ path }) => path)).toEqual(["/api/v1/me"]);
      await expect(stat(dirname(sessionFile))).rejects.toMatchObject({ code: "ENOENT" });
    }, 20000);

    it("reports a missing refresh token without persisting or printing partial credentials", async () => {
      omitRefreshToken = true;
      const result = await failure(cli("login"));
      expect(result.stderr).toContain("did not issue a refresh token");
      expect(result.stdout + result.stderr).not.toContain("synthetic-access-token-never-log");
      await expect(readFile(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    }, 20000);
  },
);
