import { createWorkflowService } from "../src/lib/server/workflows.ts";
import { createMigrationService } from "../src/lib/server/migrations.ts";
import { createConnectorService } from "../src/lib/server/connectors.ts";
import { createRuntimeReleaseService } from "../src/lib/server/runtime-releases.ts";
import { createDirectory } from "../src/lib/server/directory.ts";
import * as contract from "@platform/contracts";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createAppAccessService } from "../src/lib/server/app-access.ts";
import { createNetworkService } from "../src/lib/server/network.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createAgentService } from "../src/lib/server/agents.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createJobService } from "../src/lib/server/jobs.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createUploadService } from "../src/lib/server/uploads.ts";
import { createTelemetry } from "../src/lib/server/telemetry.ts";
import { agents, artifacts, deployments } from "../src/lib/server/schema.ts";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../", import.meta.url));

// Small protobuf fixtures exercise the actual OTLP HTTP receiver, resource
// processor and ClickHouse exporter without another production dependency.
const field = (number: number, value: Buffer) => {
  let size = value.length;
  const length: number[] = [];

  while (size > 127) {
    length.push((size & 127) | 128);
    size >>>= 7;
  }

  length.push(size);

  return Buffer.concat([Buffer.from([(number << 3) | 2, ...length]), value]);
};

const string = (number: number, value: string) => field(number, Buffer.from(value));

const fixed64 = (number: number, value: bigint) => {
  const bytes = Buffer.alloc(9);
  bytes[0] = (number << 3) | 1;
  bytes.writeBigUInt64LE(value, 1);

  return bytes;
};

const resource = (spoofedApp: string) =>
  field(1, field(1, Buffer.concat([string(1, "service.name"), field(2, string(1, spoofedApp))])));

const logBatch = (bodies: string[], app: string, trace: string, when = Date.now(), fraction = 0n) =>
  field(
    1,
    Buffer.concat([
      resource(app),
      field(
        2,
        Buffer.concat(
          bodies.map((body) =>
            field(
              2,
              Buffer.concat([
                fixed64(1, BigInt(when) * 1_000_000n + fraction),
                Buffer.from([16, 17]),
                string(3, "ERROR"),
                field(5, string(1, body)),
                field(9, Buffer.from(trace, "hex")),
                field(10, Buffer.from("1234567890123456", "hex")),
              ]),
            ),
          ),
        ),
      ),
    ]),
  );

const traceBatch = (app: string, trace: string) =>
  field(
    1,
    Buffer.concat([
      resource(app),
      field(
        2,
        field(
          2,
          Buffer.concat([
            field(1, Buffer.from(trace, "hex")),
            field(2, Buffer.from("1234567890123456", "hex")),
            string(5, "worker.fetch"),
            Buffer.from([48, 2]),
            fixed64(7, BigInt(Date.now()) * 1_000_000n),
            fixed64(8, BigInt(Date.now() + 1) * 1_000_000n),
            field(15, Buffer.concat([string(2, "uncaught-native-fixture"), Buffer.from([24, 2])])),
          ]),
        ),
      ),
    ]),
  );

describe.runIf(process.env["RUN_TELEMETRY_TESTS"] === "1")(
  "OTLP, ClickHouse and authorized runtime logs",
  () => {
    let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
    let api: ReturnType<typeof createApi>;
    let telemetry: ReturnType<typeof createTelemetry>;
    let adminHeaders: Headers;
    let outsiderHeaders: Headers;
    let appId: string;
    let otherId: string;
    let agentId: string;
    let adminId: string;
    let origin: string;

    const listener = createServer((request, response) => {
      const dispatch = async () => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));

        const headers = new Headers();

        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }

        const result = await api(
          new Request(`${origin}${request.url ?? "/"}`, {
            method: request.method ?? "GET",
            headers,
            body: chunks.length ? Buffer.concat(chunks) : null,
          }),
        );

        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      };

      void dispatch().catch((cause: unknown) => {
        response.writeHead(500);
        response.end(String(cause));
      });
    });

    const trace = crypto.randomUUID().replaceAll("-", "");
    const deploymentId = crypto.randomUUID();
    const browserDeploymentId = crypto.randomUUID();
    const objects = new Map<string, Uint8Array>();

    beforeAll(async () => {
      listener.listen(0, "127.0.0.1");
      await once(listener, "listening");
      origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(listener.address()).port}`;
      environment = await createTestEnvironment(origin);
      const configuration = environment.configuration;
      configuration.CLICKHOUSE_URL = "http://127.0.0.1:25481";
      configuration.CLICKHOUSE_PASSWORD = "local-reader-only";
      configuration.OTEL_COLLECTOR_URL = "http://127.0.0.1:25482";

      const storage = createStorage(configuration, {
        put: async (key, bytes) => {
          objects.set(key, bytes);
        },
        get: async (key) => {
          const bytes = objects.get(key);

          if (!bytes) throw new Error("Missing fixture object");

          return bytes;
        },
        exists: async (key) => objects.has(key),
        list: async function* (prefix) {
          for (const [key, bytes] of objects)
            if (key.startsWith(prefix)) yield { key, size: bytes.byteLength };
        },
        remove: async (keys) => {
          for (const key of keys) objects.delete(key);
        },
      });

      telemetry = createTelemetry(environment.database.db, storage, configuration);
      api = createApi({
        directory: createDirectory(configuration),
        ...environment,
        storage,
        telemetry,
        apps: createAppService(environment.database.db, configuration),
        network: createNetworkService(environment.database.db),
        appAccess: createAppAccessService(environment.database.db, environment.configuration),
        workflows: createWorkflowService(environment.database.db),
        migrations: createMigrationService(environment.database.db, storage),
        connectors: createConnectorService(
          environment.database.db,
          storage,
          "local-integration-test-encryption-key-only",
        ),
        agents: createAgentService(environment.database.db),
        identity: createIdentityService(environment.auth, environment.database.db, configuration),
        jobs: createJobService(
          environment.database.db,
          storage,
          "local-integration-test-encryption-key-only",
        ),
        releases: createRuntimeReleaseService(environment.database.db, storage),
        uploads: createUploadService(environment.database.db, storage, configuration),
      });
      const admin = environment.users.createUser({ email: "telemetry-admin@example.test" });
      adminId = admin.id;
      const outsider = environment.users.createUser({ email: "telemetry-outsider@example.test" });

      for (const user of [admin, outsider]) await environment.users.saveUser(user);
      await environment.linkMicrosoftUser(admin.id, z.uuid().parse(environment.ownerSubject));
      await environment.linkMicrosoftUser(outsider.id);
      adminHeaders = new Headers((await environment.users.login({ userId: admin.id })).headers);
      outsiderHeaders = new Headers(
        (await environment.users.login({ userId: outsider.id })).headers,
      );
      const headers = new Headers(adminHeaders);
      headers.set("origin", configuration.PLATFORM_URL);
      headers.set("content-type", "application/json");

      const registered = await api(
        new Request(`${configuration.PLATFORM_URL}/api/v1/agents`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Telemetry fixture" }),
        }),
      );

      agentId = z.object({ agent: contract.agent }).parse(await registered.json()).agent.id;

      for (const slug of ["telemetry-a", "telemetry-b"]) {
        const created = await api(
          new Request(`${configuration.PLATFORM_URL}/api/v1/apps`, {
            method: "POST",
            headers,
            body: JSON.stringify({ slug, displayName: slug }),
          }),
        );

        const app = contract.app.parse(await created.json());

        if (slug === "telemetry-a") appId = app.id;
        else otherId = app.id;
      }

      const bytes = Buffer.from(
        JSON.stringify({
          version: 3,
          sources: ["src/routes/+page.svelte"],
          names: ["onClick"],
          mappings: "AAAAA",
          sourcesContent: ["throw new Error('browser fixture');"],
        }),
      );

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      objects.set(`apps/${appId}/modules/${sha256}`, bytes);
      const artifactId = crypto.randomUUID();
      await environment.database.db.insert(artifacts).values({
        id: artifactId,
        appId,
        manifest: {},
        modules: [{ name: "browser.map", type: "sourcemap", sha256, size: bytes.length }],
        metadata: {
          main_module: "worker.js",
          compatibility_date: "2026-01-01",
          compatibility_flags: [],
          bindings: [],
          assets: { upload_session: crypto.randomUUID(), binding: "ASSETS" },
          debug: {
            build_id: "old-tab-build",
            source_maps: { "/_app/immutable/test.js": "browser.map" },
          },
        },
      });
      await environment.database.db
        .insert(deployments)
        .values({ id: browserDeploymentId, appId, artifactId, requestId: crypto.randomUUID() });

      const [stored] = await environment.database.db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, artifactId));

      if (!stored) throw new Error("Missing fixture artifact");
      const metadata = contract.workerMetadata.parse(stored.metadata);
      const serverArtifactId = crypto.randomUUID();
      await environment.database.db.insert(artifacts).values({
        ...stored,
        id: serverArtifactId,
        metadata: { ...metadata, debug: { build_id: "server-build", source_maps: {} } },
      });
      await environment.database.db.insert(deployments).values({
        id: deploymentId,
        appId,
        artifactId: serverArtifactId,
        requestId: crypto.randomUUID(),
      });
    });

    afterAll(async () => {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
      await environment?.close();
    });

    const read = (query = "", headers = adminHeaders, app = appId) =>
      api(
        new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps/${app}/logs${query}`, {
          headers,
        }),
      );

    const page = async (query = "") => {
      const response = await read(query);

      if (!response.ok)
        throw new Error(`Logs returned ${response.status}: ${await response.text()}`);

      return contract.logPage.parse(await response.json());
    };

    const ingest = (
      bytes: Buffer,
      signal = "logs",
      app = appId,
      token = telemetry.credentials(app)?.token,
    ) =>
      api(
        new Request(
          `${environment.configuration.PLATFORM_URL}/api/v1/telemetry/${app}/v1/${signal}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-protobuf",
              authorization: `Bearer ${token}`,
              "x-widefleet-app-id": otherId,
            },
            body: Buffer.from(bytes),
          },
        ),
      );

    it("binds OTLP to the authenticated app and resolves old browser builds", async () => {
      const bodies = [
        JSON.stringify({
          widefleet: 1,
          kind: "error",
          source: "browser",
          buildId: "old-tab-build",
          message: "browser-fixture",
          stack:
            "Error: browser-fixture\n    at onClick (https://app.example.test/_app/immutable/test.js:1:1)",
          requestId: "browser-ingest",
        }),
        JSON.stringify({
          widefleet: 1,
          kind: "request",
          source: "server",
          buildId: "server-build",
          deploymentId,
          requestId: "server-request",
          route: "/probe",
          status: 500,
          message: "GET /probe 500",
        }),
        "plain-console-fixture",
      ];

      expect((await ingest(logBatch(bodies, otherId, trace))).status).toBe(200);
      expect((await ingest(traceBatch(otherId, trace), "traces")).status).toBe(200);
      await vi.waitFor(async () => expect((await page()).entries).toHaveLength(4), {
        timeout: 15_000,
      });
      const result = await page();
      const browser = result.entries.find((entry) => entry.source === "browser");
      expect(browser?.buildId).toBe("old-tab-build");
      expect(browser?.deploymentId).toBeNull();
      expect(browser?.frames[0]).toMatchObject({
        file: "src/routes/+page.svelte",
        line: 1,
        column: 1,
        name: "onClick",
      });
      expect(
        result.entries.find((entry) => entry.message === "plain-console-fixture"),
      ).toMatchObject({ deploymentId, requestId: "server-request", route: "/probe" });
      expect(result.entries.find((entry) => entry.kind === "span_error")?.message).toBe(
        "uncaught-native-fixture",
      );
      expect(
        contract.logPage.parse(await (await read("", adminHeaders, otherId)).json()).entries,
      ).toHaveLength(0);
      expect((await read("", outsiderHeaders)).status).toBe(404);
      expect(
        (
          await ingest(
            logBatch(["bad-auth"], otherId, trace),
            "logs",
            otherId,
            telemetry.credentials(appId)?.token,
          )
        ).status,
      ).toBe(401);
      expect((await page("?source=browser&level=error")).entries).toHaveLength(1);
      expect((await page(`?deploymentId=${deploymentId}&source=server`)).entries).toHaveLength(2);
      expect(
        (await page(`?deploymentId=${browserDeploymentId}&source=browser`)).entries,
      ).toHaveLength(1);
      expect((await page(`?deploymentId=${deploymentId}&source=browser`)).entries).toHaveLength(0);
      expect((await page("?query=%27%20OR%201%3D1%20--")).entries).toHaveLength(0);
    });

    it("pages without dropping equal timestamps and finds delayed records by ingestion time", async () => {
      const first = await page("?limit=2");
      expect(first.nextCursor).not.toBeNull();
      const second = await page(`?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
      expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(4);
      expect(
        (await read(`?limit=2&source=browser&cursor=${encodeURIComponent(first.nextCursor ?? "")}`))
          .status,
      ).toBe(400);
      expect((await read("?cursor=invalid.signature")).status).toBe(400);
      expect(
        (
          await ingest(
            logBatch(["delayed-export-fixture"], otherId, trace, Date.now() - 20 * 60_000),
          )
        ).status,
      ).toBe(200);
      await vi.waitFor(
        async () => {
          const delayed = await page(
            `?receivedAfter=${first.receivedThrough}&query=delayed-export`,
          );

          expect(delayed.entries).toHaveLength(1);
        },
        { timeout: 15_000 },
      );
    });

    it("preserves sub-millisecond historical boundaries through filtering and pagination", async () => {
      const when = Date.now();
      const at = (fraction: string) => new Date(when).toISOString().replace("Z", `${fraction}Z`);

      for (const [message, fraction] of new Map([
        ["precision-before", 100_000n],
        ["precision-boundary", 500_000n],
        ["precision-after", 900_000n],
      ]))
        expect((await ingest(logBatch([message], otherId, trace, when, fraction))).status).toBe(
          200,
        );
      const query = `?since=${encodeURIComponent(at("000"))}&until=${encodeURIComponent(at("500"))}&query=precision-&limit=1`;
      await vi.waitFor(
        async () => {
          const first = await page(query);
          expect(first.nextCursor).not.toBeNull();

          const second = await page(
            `${query}&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
          );

          expect(
            [...first.entries, ...second.entries]
              .map((entry) => entry.message)
              .sort((left, right) => left.localeCompare(right)),
          ).toEqual(["precision-before", "precision-boundary"]);
        },
        { timeout: 15_000 },
      );

      const exact = await page(
        `?since=${encodeURIComponent(at("200"))}&until=${encodeURIComponent(at("500"))}&query=precision-`,
      );

      expect(exact.entries.map((entry) => entry.message)).toEqual(["precision-boundary"]);

      const relative = await page(
        `?since=30d&until=${encodeURIComponent(at("500"))}&query=precision-`,
      );

      expect(relative.since).toBe(
        new Date(when - 30 * 86_400_000).toISOString().replace("Z", "500Z"),
      );
      expect((await read(`?until=${encodeURIComponent(at("5000000"))}`)).status).toBe(400);
    });

    it("paginates historical queries with an explicit timezone offset", async () => {
      const until = new Date(Date.now() + 3_600_000).toISOString().replace("Z", "+01:00");
      const query = `?since=1h&until=${encodeURIComponent(until)}&limit=1`;
      const first = await page(query);
      expect(first.nextCursor).not.toBeNull();
      const second = await page(`${query}&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
      expect(second.since).toBe(first.since);
      expect(second.receivedThrough).toBe(first.receivedThrough);
      expect(second.entries[0]?.id).not.toBe(first.entries[0]?.id);
    });

    it("keeps thirty-day history pages stable and bounds later follow windows", async () => {
      const now = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });

      try {
        vi.setSystemTime(now);
        const first = await page("?since=30d&limit=1");
        expect(first.nextCursor).not.toBeNull();
        expect(first.since).toBe(new Date(now - 30 * 86_400_000).toISOString());

        vi.setSystemTime(now + 2000);

        const second = await page(
          `?since=30d&limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        );

        expect(second.since).toBe(first.since);
        expect(second.receivedThrough).toBe(first.receivedThrough);
        expect(second.entries[0]?.id).not.toBe(first.entries[0]?.id);

        const follow = await page(
          `?since=${encodeURIComponent(first.since)}&receivedAfter=${first.receivedThrough}`,
        );

        expect(follow.since).toBe(new Date(now + 2000 - 30 * 86_400_000).toISOString());
        expect((await read(`?since=${encodeURIComponent(first.since)}`)).status).toBe(400);
        expect((await read("?since=31d")).status).toBe(400);
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs celld and the CLI through real HTTP, including read-only resolution and follow", async () => {
      await execute("bash", ["tools/cargo.sh", "build", "--locked", "--bin", "widefleet"], {
        cwd: root,
      });
      const directory = await mkdtemp(join(tmpdir(), "widefleet-telemetry-cli-"));
      const now = Math.floor(Date.now() / 1000);

      const { token } = await environment.auth.api.signJWT({
        body: {
          payload: {
            sub: adminId,
            aud: `${origin}/api/v1`,
            iss: `${origin}/api/auth`,
            iat: now,
            exp: now + 300,
            scope: "platform:read",
          },
        },
      });

      const env = { PATH: process.env["PATH"], PLATFORM_ACCESS_TOKEN: token, PLATFORM_URL: origin };
      const binary = join(root, "target/debug/widefleet");
      let follow: ReturnType<typeof spawn> | undefined;
      let runtime: ReturnType<typeof spawn> | undefined;
      let runtimeOutput = "";

      try {
        await writeFile(
          join(directory, "wrangler.jsonc"),
          '{ // fixture\n "name": "telemetry-a", }',
        );

        const history = await execute(
          binary,
          ["logs", "--config", join(directory, "wrangler.jsonc"), "--source", "browser", "--json"],
          { env },
        );

        expect(contract.runtimeLog.parse(JSON.parse(history.stdout.trim())).frames[0]?.file).toBe(
          "src/routes/+page.svelte",
        );
        await writeFile(join(directory, "wrangler.jsonc"), '{"name":"does-not-exist"}');
        await expect(
          execute(binary, ["logs", "--config", join(directory, "wrangler.jsonc")], { env }),
        ).rejects.toThrow("App not found");

        let stdout = "";
        let stderr = "";
        follow = spawn(
          binary,
          ["logs", appId, "--follow", "--since", "30d", "--query", "live-fixture", "--json"],
          {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        follow.stdout?.on("data", (bytes: Buffer) => {
          stdout += bytes.toString();
        });
        follow.stderr?.on("data", (bytes: Buffer) => {
          stderr += bytes.toString();
        });
        await vi.waitFor(() => expect(stderr).toContain("Following runtime logs"), {
          timeout: 10_000,
        });

        const portReservation = createPortReservation();
        portReservation.listen(0, "127.0.0.1");
        await once(portReservation, "listening");
        const port = z.object({ port: z.number() }).parse(portReservation.address()).port;
        await new Promise<void>((resolve, reject) =>
          portReservation.close((error) => (error ? reject(error) : resolve())),
        );
        await writeFile(
          join(directory, "worker.js"),
          `export default { async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/failure') throw new Error('live-fixture-native');
        if (path === '/console') console.error('live-fixture-console');
        return new Response('ready');
      } };`,
        );
        await writeFile(
          join(directory, "runtime.json"),
          JSON.stringify({
            name: "telemetry-fixture",
            main: "worker.js",
            compatibility_date: "2026-01-01",
            no_bundle: true,
          }),
        );
        runtime = spawn(
          join(root, ".tools/celld"),
          [
            "dev",
            "runtime.json",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--logs",
            "--no-watch",
          ],
          {
            cwd: directory,
            env: {
              PATH: process.env["PATH"],
              RUST_LOG: "info",
              CELLD_OTEL: `${origin}/api/v1/telemetry/${appId}`,
              CELLD_OTEL_FLUSH_MS: "100",
              OTEL_TRACES_SAMPLER: "always_on",
              OTEL_SERVICE_NAME: otherId,
              OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${telemetry.credentials(appId)?.token}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        runtime.stdout?.on("data", (bytes: Buffer) => {
          runtimeOutput += bytes.toString();
        });
        runtime.stderr?.on("data", (bytes: Buffer) => {
          runtimeOutput += bytes.toString();
        });
        await vi.waitFor(
          async () => expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(200),
          { timeout: 20_000 },
        );
        await (await fetch(`http://127.0.0.1:${port}/console`)).text();
        const failure = await fetch(`http://127.0.0.1:${port}/failure`);
        expect(failure.status).toBe(500);
        await failure.text();
        await vi.waitFor(
          () => {
            expect(stdout).toContain("live-fixture-console");
            expect(stdout).toContain("live-fixture-native");
          },
          { timeout: 15_000 },
        );

        const emitted = stdout
          .trim()
          .split("\n")
          .map((line) => contract.runtimeLog.parse(JSON.parse(line)));

        expect(emitted.some((entry) => entry.kind === "span_error")).toBe(true);
        expect(new Set(emitted.map((entry) => entry.id)).size).toBe(emitted.length);
      } catch (cause) {
        throw new Error(`CLI/runtime telemetry fixture failed: ${runtimeOutput.slice(-4000)}`, {
          cause,
        });
      } finally {
        for (const child of [follow, runtime]) {
          if (child && child.exitCode === null) {
            const closed = once(child, "close");
            child.kill("SIGINT");
            await closed;
          }
        }

        await rm(directory, { recursive: true, force: true });
      }
    }, 120_000);

    it("keeps ClickHouse read-only and accepts app telemetry after disabling the deployment executor", async () => {
      const response = await fetch("http://127.0.0.1:25481", {
        method: "POST",
        headers: {
          "x-clickhouse-user": "widefleet_reader",
          "x-clickhouse-key": "local-reader-only",
        },
        body: "CREATE TABLE widefleet.forbidden_fixture (id Int32) ENGINE=Memory",
      });

      expect(response.ok).toBe(false);
      await response.body?.cancel();
      await environment.database.db
        .update(agents)
        .set({ enabled: false })
        .where(eq(agents.id, agentId));
      expect((await ingest(logBatch(["executor-disabled"], otherId, trace))).status).toBe(200);
    });
  },
);
