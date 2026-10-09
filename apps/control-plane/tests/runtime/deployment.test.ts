import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { and, eq } from "drizzle-orm";
import { fleets, jobs } from "../../src/lib/server/schema.ts";
import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import * as contract from "@platform/contracts";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as upstreamRequest } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiResource } from "../../src/lib/server/auth-options.ts";
import { hashAsset } from "../../src/lib/server/asset-hash.ts";
import { createTestEnvironment } from "../environment.ts";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const runRuntime = process.env["RUN_RUNTIME_TESTS"] === "1";

// Each local checkout can reserve its own control-plane/proxy port pair.
const proxyPort = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65534)
  .parse(process.env["RUNTIME_TEST_PORT"] ?? 25430);

const serverPort = proxyPort + 1;

describe.runIf(runRuntime)("CLI, agent and celld with persistent D1/R2", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let server: ReturnType<typeof spawn>;
  let s3: S3Client;
  let state: string;
  let accessToken: string;
  let managementHeaders: Headers;
  let agentToken: string;
  let fleetId: string;
  let dockerHost: string;
  let proxy: ReturnType<typeof createServer>;
  const createdApps: string[] = [];
  const hostnames = new Map<string, string>();
  let serverLogs = "";
  let rejectCompletion = false;
  let rejectHeartbeat = false;
  let activeAgent: ReturnType<typeof execFile> | undefined;
  let cliExecutable: string;
  let appDirectory: string;
  const telemetryEnabled = false;

  const clientEnvironment = {
    ...process.env,
    PATH: (process.env["PATH"] ?? "")
      .split(delimiter)
      .filter((entry) => !entry.startsWith(root))
      .join(delimiter),
    NODE_PATH: "",
  };

  const startServer = async () => {
    server = spawn(process.execPath, ["build"], {
      cwd: join(root, "apps/control-plane"),
      env: {
        ...process.env,
        ...environment.environment,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(serverPort),
        PROTOCOL_HEADER: "x-forwarded-proto",
        SHUTDOWN_TIMEOUT: "1",
        BODY_SIZE_LIMIT: "100M",
        CLICKHOUSE_URL: telemetryEnabled ? "http://127.0.0.1:25481" : undefined,
        CLICKHOUSE_PASSWORD: "local-reader-only",
        OTEL_COLLECTOR_URL: "http://127.0.0.1:25482",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      serverLogs += chunk;
    });
    server.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      serverLogs += chunk;
    });
    await vi.waitFor(
      async () => {
        if (server.exitCode !== null) throw new Error(serverLogs);
        expect((await fetch(`${environment.configuration.PLATFORM_URL}/healthz`)).ok).toBe(true);
      },
      { timeout: 15_000 },
    );
  };

  const stopServer = async () => {
    if (server?.exitCode === null) {
      const exited = once(server, "exit");
      const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
      server.kill("SIGTERM");
      await exited;
      clearTimeout(timeout);
    }
  };

  const request = async <T>(
    path: string,
    method: "GET" | "POST" | "DELETE" | "PATCH",
    body?: T,
  ) => {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      origin: environment.configuration.PLATFORM_URL,
      "x-forwarded-proto": "http",
      "content-type": "application/json",
    };

    const options: RequestInit = { method, headers };

    if (body !== undefined) {
      if (method === "GET") throw new Error("GET cannot have a body");
      options.body = JSON.stringify(body);
    }

    const response = await fetch(
      `${environment.configuration.PLATFORM_URL}/api/v1${path}`,
      options,
    );

    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);

    return response;
  };

  beforeAll(async () => {
    environment = await createTestEnvironment(`http://localhost:${proxyPort}`);
    state = await mkdtemp(join(tmpdir(), "platform-runtime-test-"));
    const bucket = `runtime-test-${crypto.randomUUID()}`;
    environment.configuration.S3_BUCKET = bucket;
    environment.environment.S3_BUCKET = bucket;
    s3 = new S3Client({
      endpoint: environment.configuration.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "local-tests", secretAccessKey: "local-tests-only" },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    const person = environment.users.createUser({
      name: "Runtime Test",
      email: "runtime@example.test",
    });

    await environment.users.saveUser(person);
    await environment.linkMicrosoftUser(person.id, z.uuid().parse(environment.ownerSubject));
    managementHeaders = new Headers((await environment.users.login({ userId: person.id })).headers);
    managementHeaders.set("origin", environment.configuration.PLATFORM_URL);
    managementHeaders.set("x-forwarded-proto", "http");
    managementHeaders.set("content-type", "application/json");
    const now = Math.floor(Date.now() / 1000);
    accessToken = (
      await environment.auth.api.signJWT({
        body: {
          payload: {
            sub: person.id,
            aud: apiResource(environment.configuration),
            iss: `${environment.configuration.PLATFORM_URL}/api/auth`,
            iat: now,
            exp: now + 900,
            scope: "platform:read platform:write network:manage",
          },
        },
      })
    ).token;
    managementHeaders.delete("cookie");
    managementHeaders.set("authorization", `Bearer ${accessToken}`);
    dockerHost = (
      await execute("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
    ).stdout.trim();
    // A private fixture proxy supplies the same trusted protocol header as Traefik.
    // The real CLI sends only its public Origin and never forges proxy headers.
    proxy = createServer((incoming, outgoing) => {
      if (rejectHeartbeat && incoming.url?.endsWith("/heartbeat")) {
        incoming.resume();
        outgoing.writeHead(503).end("Synthetic heartbeat failure");

        return;
      }

      if (rejectCompletion && incoming.url?.endsWith("/complete")) {
        incoming.resume();
        outgoing.writeHead(503).end("Synthetic lost completion");

        return;
      }

      const upstream = upstreamRequest(
        {
          hostname: "127.0.0.1",
          port: serverPort,
          path: incoming.url,
          method: incoming.method,
          headers: { ...incoming.headers, "x-forwarded-proto": "http" },
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );

      upstream.on("error", () => outgoing.writeHead(502).end());
      incoming.pipe(upstream);
    });
    proxy.listen(proxyPort, "127.0.0.1");
    await once(proxy, "listening");
    await startServer();

    const registration = z
      .object({ agent: contract.agent, token: z.string() })
      .parse(await (await request("/agents", "POST", { name: "Runtime fixture agent" })).json());

    const [fleet] = await environment.database.db.select().from(fleets);

    if (!fleet) throw new Error("Missing fleet");
    fleetId = fleet.id;
    agentToken = registration.token;

    let archive = process.env["CLI_RELEASE_ARCHIVE"];
    const npmPackage = process.env["CLI_NPM_PACKAGE"];

    if (!archive && !npmPackage) {
      const packaged = await execute(
        process.execPath,
        [
          "tools/package-cli.ts",
          "--binary",
          "target/debug/widefleet",
          "--output",
          join(state, "release output"),
        ],
        { cwd: root, maxBuffer: 8 * 1024 * 1024 },
      );

      archive = packaged.stdout.trim();
    }

    if (npmPackage) {
      const pnpmHome = join(state, "pnpm home");
      const bin = join(pnpmHome, "bin");
      await mkdir(bin, { recursive: true });
      await execute(
        "pnpm",
        [
          `--config.global-dir=${join(state, "global packages")}`,
          "add",
          "--global",
          "--ignore-scripts",
          npmPackage,
        ],
        {
          cwd: state,
          env: {
            ...clientEnvironment,
            PNPM_HOME: pnpmHome,
            PATH: `${bin}${delimiter}${clientEnvironment.PATH}`,
          },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      cliExecutable = join(bin, "widefleet");
    } else {
      const installed = join(state, "installed CLI");
      await mkdir(installed);
      await execute("tar", [
        "-xzf",
        z.string().parse(archive),
        "-C",
        installed,
        "--strip-components=1",
      ]);
      cliExecutable = join(state, "widefleet");
      await symlink(join(installed, "widefleet"), cliExecutable);
    }
  }, 120_000);

  afterAll(async () => {
    await stopServer();

    if (proxy)
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );

    // Remove only app IDs created by this isolated fixture, including partial failures.
    if (fleetId) {
      const name = `platform-fleet-${fleetId}`;
      await execute("docker", ["rm", "-f", name]).catch(() => undefined);
      await execute("docker", [
        "network",
        "disconnect",
        name,
        "internal-app-platform-test-rustfs-1",
      ]).catch(() => undefined);
      await execute("docker", ["network", "rm", name]).catch(() => undefined);
    }

    if (s3) {
      while (true) {
        const page = await s3.send(
          new ListObjectsV2Command({ Bucket: environment.configuration.S3_BUCKET }),
        );

        const objects = (page.Contents ?? []).flatMap((entry) =>
          entry.Key ? [{ Key: entry.Key }] : [],
        );

        if (objects.length === 0) break;
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: environment.configuration.S3_BUCKET,
            Delete: { Objects: objects },
          }),
        );
      }

      await s3.send(new DeleteBucketCommand({ Bucket: environment.configuration.S3_BUCKET }));
      s3.destroy();
    }

    if (state) await rm(state, { recursive: true, force: true });
    await environment?.close();
  });

  const agent = (
    runtimeImage = process.env["PLATFORM_RUNTIME_IMAGE"],
    platformUrl = environment.configuration.PLATFORM_URL,
    celld = join(root, ".tools/celld"),
    edge?: { proxy: string; auth: string },
  ) => {
    const operation = execute(join(root, "target/debug/platform-agent"), ["--once"], {
      cwd: root,
      timeout: 120_000,
      env: {
        ...process.env,
        DOCKER_HOST: dockerHost,
        PLATFORM_URL: platformUrl,
        PLATFORM_AGENT_TOKEN: agentToken,
        PLATFORM_AGENT_STATE: state,
        PLATFORM_RUNTIME_IMAGE: runtimeImage,
        PLATFORM_ROUTING_DIRECTORY: join(state, "routes"),
        APP_DOMAIN: environment.configuration.APP_DOMAIN,
        TLS_MODE: "cloudflare",
        CELLD_BINARY: celld,
        PLATFORM_PROXY_URL: edge?.proxy,
        PLATFORM_APP_AUTH_URL: edge?.auth,
        FLEET_S3_ENDPOINT: "http://127.0.0.1:25400",
        FLEET_RUNTIME_S3_ENDPOINT: "http://internal-app-platform-test-rustfs-1:9000",
        FLEET_S3_BUCKET: environment.configuration.S3_BUCKET,
        FLEET_S3_ACCESS_KEY_ID: "local-tests",
        FLEET_S3_SECRET_ACCESS_KEY: "local-tests-only",
        PLATFORM_TRUSTED_CONTAINERS: "internal-app-platform-test-rustfs-1",
        // Runtime transport is tested separately with a real local celld. This
        // fixture checks recreation/state and must not contact an external host.
        PLATFORM_RUNTIME_PLATFORM_URL: "http://telemetry.invalid",
      },
    });

    activeAgent = operation.child;

    return operation.catch(async (cause: unknown) => {
      const logs = await Promise.allSettled(
        createdApps.map(async (id) => {
          const result = await execute("docker", [
            "logs",
            "--tail",
            "100",
            `platform-fleet-${fleetId}`,
          ]);

          return `${id}:\n${result.stdout}\n${result.stderr}`;
        }),
      );

      throw new Error(
        `Agent command failed: ${String(cause)}\nFixture runtime logs:\n${logs.map((result) => (result.status === "fulfilled" ? result.value : String(result.reason))).join("\n")}`,
        { cause },
      );
    });
  };

  const createApp = async (slug: string, parentId: string | null = null, previewName?: string) => {
    const app = contract.app.parse(
      await (
        await request("/apps", "POST", { slug, displayName: slug, parentId, previewName })
      ).json(),
    );

    createdApps.push(app.id);
    hostnames.set(app.id, app.hostname);

    return app;
  };

  const publish = async (
    appId: string,
    version: string,
    source?: string,
    bindings?: z.infer<typeof contract.workerBinding>[],
  ) => {
    const bytes = Buffer.from("static asset");
    const hash = hashAsset("/note.txt", bytes);

    const session = contract.uploadSession.parse(
      await (
        await request(`/apps/${appId}/assets-upload-session`, "POST", {
          manifest: { "/note.txt": { hash, size: bytes.length } },
        })
      ).json(),
    );

    if (session.missing.length) {
      const response = await fetch(
        `${environment.configuration.PLATFORM_URL}/api/v1/apps/${appId}/assets/${session.id}/${hash}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${accessToken}`,
            origin: environment.configuration.PLATFORM_URL,
            "x-forwarded-proto": "http",
          },
          body: bytes,
        },
      );

      expect(response.status).toBe(200);
    }

    const code =
      source ??
      `export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/note.txt') return env.ASSETS.fetch(request);
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)').run();
      if (request.method === 'POST') {
        await env.DB.prepare('INSERT INTO counter (id, value) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1').run();
        await env.FILES.put('photo', 'saved-file');
      }
      const row = await env.DB.prepare('SELECT value FROM counter WHERE id = 1').first();
      const file = await env.FILES.get('photo');
      return Response.json({ version: ${JSON.stringify(version)}, count: row?.value ?? 0, file: file ? await file.text() : null });
    } };`;

    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_als"],
        bindings: bindings ?? [
          {
            type: "d1",
            name: "DB",
            database_name: "notes",
            database_id: "same-logical-id-in-every-fixture-app",
          },
          { type: "r2_bucket", name: "FILES", bucket_name: "files" },
        ],
        assets: { upload_session: session.id, binding: "ASSETS" },
      }),
    );
    form.set("worker.js", new Blob([code], { type: "application/javascript+module" }), "worker.js");

    const response = await fetch(
      `${environment.configuration.PLATFORM_URL}/api/v1/apps/${appId}/worker`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${accessToken}`,
          origin: environment.configuration.PLATFORM_URL,
          "x-forwarded-proto": "http",
          "idempotency-key": crypto.randomUUID(),
        },
        body: form,
      },
    );

    if (!response.ok) throw new Error(await response.text());

    return contract.deployment.parse(await response.json());
  };

  const appRequest = (appId: string, method = "GET", path = "/") =>
    execute("docker", [
      "exec",
      `platform-fleet-${fleetId}`,
      "curl",
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      "15",
      "-X",
      method,
      "-H",
      `Host: ${hostnames.get(appId)}`,
      `http://127.0.0.1:8080${path}`,
    ]);

  const appState = async (appId: string, method = "GET") =>
    z
      .object({ version: z.string(), count: z.number(), file: z.string().nullable() })
      .parse(JSON.parse((await appRequest(appId, method)).stdout));

  const cli = (...args: string[]) =>
    execute(cliExecutable, args, {
      cwd: appDirectory,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...clientEnvironment,
        PLATFORM_URL: environment.configuration.PLATFORM_URL,
        PLATFORM_ACCESS_TOKEN: accessToken,
      },
    });

  const manageRuntime = async (path: string, body?: z.infer<typeof contract.runtimeRelease>) => {
    const response = await fetch(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, {
      method: body ? "PUT" : "GET",
      headers: managementHeaders,
      body: body ? JSON.stringify(body) : null,
    });

    if (!response.ok) throw new Error(await response.text());

    return z.json().parse(await response.json());
  };

  const bundledRuntime = async () =>
    contract.runtimeRelease.parse(
      JSON.parse(
        await readFile(new URL(import.meta.resolve("@platform/app-runtime/release")), "utf8"),
      ),
    );

  const installed = async () => ({ runtime: await bundledRuntime() });

  const wrappedRuntime = async (version: string, wrapper: string) => {
    const runtime = await bundledRuntime();
    const directory = await mkdtemp(join(state, "wrapped-runtime-"));

    for (const module of runtime.modules)
      await writeFile(
        join(directory, module.name === runtime.main ? "fixture-original.js" : module.name),
        module.source,
      );

    const bundled = await build({
      stdin: { contents: wrapper, resolveDir: directory },
      bundle: true,
      format: "esm",
      platform: "neutral",
      external: ["cloudflare:workers", "cloudflare:workflows"],
      write: false,
    });

    const source = bundled.outputFiles[0]?.text;

    if (!source) throw new Error("Missing bundled runtime fixture");

    return {
      ...runtime,
      version,
      modules: [
        { name: runtime.main, source, sha256: createHash("sha256").update(source).digest("hex") },
      ],
    };
  };

  it("rejects mismatched native binaries before publishing or starting fleet state", async () => {
    appDirectory = state;
    const runtime = await bundledRuntime();
    const directory = join(state, "native-version-fixture");
    const binary = join(directory, "celld");
    const image = `widefleet-native-version-test:${fleetId}`;
    const container = `platform-fleet-${fleetId}`;
    const selectedImage = process.env["PLATFORM_RUNTIME_IMAGE"] ?? "app-platform-runtime:0.1.0";
    await mkdir(directory);
    await writeFile(binary, '#!/bin/sh\nprintf "celld 0.0.0\\n"\n', { mode: 0o755 });
    await writeFile(
      join(directory, "Dockerfile"),
      `FROM ${selectedImage}\nCOPY celld /usr/local/bin/celld\n`,
    );
    await execute("docker", ["build", "-t", image, directory]);

    const rejected = async (operation: () => ReturnType<typeof agent>, message: string) => {
      await manageRuntime("/runtime", runtime);
      await expect(operation()).rejects.toThrow(message);
      expect(await manageRuntime("/runtime")).toMatchObject({
        activeVersion: null,
        state: "failed",
      });

      const objects = await s3.send(
        new ListObjectsV2Command({
          Bucket: environment.configuration.S3_BUCKET,
          Prefix: `fleets/${fleetId}/`,
        }),
      );

      expect(objects.Contents ?? []).toEqual([]);
      expect(
        (
          await execute("docker", [
            "ps",
            "-a",
            "--filter",
            `name=^/${container}-version-check$`,
            "--format",
            "{{.Names}}",
          ])
        ).stdout.trim(),
      ).toBe("");
    };

    try {
      await rejected(
        () => agent(undefined, undefined, binary),
        "Publisher binary requires celld 0.6.2",
      );
      await writeFile(binary, '#!/bin/sh\nprintf "celld 0.6.2\\n"\nexit 1\n');
      await rejected(
        () => agent(undefined, undefined, binary),
        "Publisher celld version check failed",
      );
      await rejected(() => agent(image), "Configured runtime image requires celld 0.6.2");
      expect(
        (
          await execute("docker", ["ps", "-a", "--filter", `name=^/${container}$`, "-q"])
        ).stdout.trim(),
      ).toBe("");

      const existing = await execute("docker", [
        "run",
        "--detach",
        "--name",
        container,
        "--label",
        `app-platform.fleet-id=${fleetId}`,
        "--entrypoint",
        "/bin/sleep",
        image,
        "infinity",
      ]);

      for (const running of [true, false]) {
        if (!running) await execute("docker", ["stop", container]);
        await rejected(() => agent(), `Fleet container ${container} requires celld 0.6.2`);
        expect(
          (
            await execute("docker", [
              "inspect",
              "--format",
              "{{.Id}} {{.State.Running}}",
              container,
            ])
          ).stdout.trim(),
        ).toBe(`${existing.stdout.trim()} ${running}`);
      }

      await execute("docker", ["rename", container, `${container}-previous`]);
      await rejected(() => agent(), `Fleet container ${container}-previous requires celld 0.6.2`);
    } finally {
      for (const name of [container, `${container}-previous`, `${container}-version-check`])
        await execute("docker", ["rm", "-f", name]).catch(() => undefined);
      await execute("docker", ["image", "rm", image]);
    }
  }, 120000);

  it("activates a runtime without apps and rolls it back through the CLI after replacing the executor", async () => {
    appDirectory = state;
    const original = await bundledRuntime();
    await manageRuntime("/runtime", original);
    await agent();
    expect(await manageRuntime("/runtime")).toMatchObject({
      activeVersion: original.version,
      state: "succeeded",
    });
    expect(createdApps).toHaveLength(0);
    const container = `platform-fleet-${fleetId}`;
    const first = (await execute("docker", ["inspect", "--format", "{{.Id}}", container])).stdout;

    const replacement = z
      .object({ agent: contract.agent, token: z.string() })
      .parse(await (await request("/agents", "POST", { name: "Replacement executor" })).json());

    agentToken = replacement.token;
    const version = "0.1.2";

    const next = {
      ...original,
      version,
      modules: original.modules.map((module) => {
        const source = module.source.replaceAll(
          `runtimeVersion: ${JSON.stringify(original.version)}`,
          `runtimeVersion: ${JSON.stringify(version)}`,
        );

        return { ...module, source, sha256: createHash("sha256").update(source).digest("hex") };
      }),
    };

    await manageRuntime("/runtime", next);
    await agent();
    expect(await manageRuntime("/runtime")).toMatchObject({
      activeVersion: version,
      state: "succeeded",
    });
    expect((await execute("docker", ["inspect", "--format", "{{.Id}}", container])).stdout).toBe(
      first,
    );

    const rollback = contract.runtimeStatus.parse(
      JSON.parse((await cli("runtime", "rollback", original.version, "--no-wait")).stdout),
    );

    expect(rollback.state).toBe("queued");
    await agent();
    expect(
      contract.runtimeStatus.parse(JSON.parse((await cli("runtime", "status")).stdout)),
    ).toMatchObject({ activeVersion: original.version, state: "succeeded" });
  }, 120000);

  it("restores a failed runtime update and restarts from the last serving release without the control plane", async () => {
    const draft = await createApp("runtime-unpublished");
    const healthy = await createApp("runtime-a-healthy");
    const app = await createApp("runtime-z-failure");
    await publish(healthy.id, "healthy");
    await agent();
    await publish(app.id, "before");
    await agent();
    expect(await appState(app.id, "POST")).toMatchObject({ count: 1 });
    const current = await installed();

    // Runtime health and the first app pass, but the second app cannot load.
    // Accepting only the first snapshot would publish a broken fleet release.
    const broken = await wrappedRuntime(
      "0.1.99",
      `
      import runtime from './fixture-original.js';
      export * from './fixture-original.js';
      export default { ...runtime, async fetch(request, env, ctx) {
        if (request.headers.get('x-widefleet-candidate')?.startsWith('${app.id}/'))
          return new Response('App loading failed', { status: 500 });
        const response = await runtime.fetch(request, env, ctx);
        if (new URL(request.url).pathname === '/.well-known/widefleet/runtime' && response.ok)
          return Response.json({ runtimeVersion: '0.1.99' });
        return response;
      } };
    `,
    );

    await manageRuntime("/runtime", broken);

    const [activation] = await environment.database.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.fleetId, fleetId), eq(jobs.state, "queued")));

    expect(activation?.appId).toBeNull();
    expect(activation?.kind).toBe("runtime");
    await expect(agent()).rejects.toThrow();
    expect(await appState(healthy.id)).toMatchObject({ version: "healthy" });
    expect(await appState(app.id)).toMatchObject({ version: "before", count: 1 });
    await stopServer();
    await execute("docker", ["restart", `platform-fleet-${fleetId}`]);
    await vi.waitFor(
      async () => expect(await appState(app.id)).toMatchObject({ version: "before", count: 1 }),
      { timeout: 45000 },
    );
    await startServer();
    // Deletion must use the serving release, not the failed desired update.
    await request(`/apps/${app.id}`, "DELETE");
    await agent();
    await expect(appRequest(app.id)).rejects.toThrow("404");
    await manageRuntime("/runtime", current.runtime);
    await agent();
    await request(`/apps/${draft.id}`, "DELETE");
    await agent();
    await request(`/apps/${healthy.id}`, "DELETE");
    await agent();
  }, 120000);

  it("deploys an independent connector project with direct native RPC, durable state and safe revocation", async () => {
    const project = join(state, "independent connector");
    await mkdir(project);

    // These private identifiers collided with the former appended platform helper.
    const source = `import { WorkerEntrypoint as WIDEFLEET_SecretEntrypoint, DurableObject } from 'cloudflare:workers';
      export class ErpConnection extends DurableObject {
        async next() { const value = (await this.ctx.storage.get('sequence') ?? 0) + 1; await this.ctx.storage.put('sequence', value); return value; }
      }
      class WIDEFLEET_Secrets extends WIDEFLEET_SecretEntrypoint {
        async listCustomers() { return { customers: ['fixture'], sequence: await this.env.STATE.getByName('connection').next(), rootBinding: 'WIDEFLEET_PACKAGES' in this.env }; }
        async secretProbe() { try { return { value: await this.env.WIDEFLEET_SECRETS.get('API_KEY') }; } catch (error) { return { error: error.message }; } }
        async storageProbe() {
          await this.env.DB.exec('CREATE TABLE IF NOT EXISTS connector_marker (id INTEGER PRIMARY KEY, value TEXT)');
          await this.env.DB.prepare('INSERT OR REPLACE INTO connector_marker VALUES (1, ?)').bind('connector').run();
          await this.env.KV.put('marker', 'connector');
          await this.env.FILES.put('marker', 'connector');
          return { db: await this.env.DB.prepare('SELECT value FROM connector_marker').first('value'), kv: await this.env.KV.get('marker'), file: await (await this.env.FILES.get('marker')).text() };
        }
      }
      export { WIDEFLEET_Secrets as ERP };
      export default WIDEFLEET_Secrets;`;

    await writeFile(join(project, "worker.ts"), source);
    const config = join(project, "wrangler.jsonc");
    await writeFile(
      config,
      JSON.stringify({
        name: "erp-fixture",
        main: "worker.ts",
        compatibility_date: "2026-10-01",
        vars: { API_KEY: "ordinary-variable-is-not-a-secret" },
        d1_databases: [{ binding: "DB", database_name: "notes", database_id: "local" }],
        kv_namespaces: [{ binding: "KV", id: "fixture" }],
        r2_buckets: [{ binding: "FILES", bucket_name: "files" }],
        durable_objects: { bindings: [{ name: "STATE", class_name: "ErpConnection" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["ErpConnection"] }],
      }),
    );
    const deploy = () => cli("connector", "deploy", "--config", config, "--no-wait");
    expect(JSON.parse((await deploy()).stdout)).toMatchObject({
      name: "erp-fixture",
      state: "queued",
      entrypoints: ["ERP", "default"],
    });
    await agent();
    expect(JSON.parse((await cli("connector", "show", "erp-fixture")).stdout)).toMatchObject({
      state: "succeeded",
    });
    const app = await createApp("connector-consumer");
    await publish(
      app.id,
      "before",
      `export default { async fetch(request, env) {
        if (new URL(request.url).pathname === '/secret') return Response.json({ connector: await env.ERP.secretProbe(), exposed: 'WIDEFLEET_SECRETS' in env });
        if (new URL(request.url).pathname === '/storage') {
          await env.DB.exec('CREATE TABLE IF NOT EXISTS connector_marker (id INTEGER PRIMARY KEY, value TEXT)');
          await env.DB.prepare('INSERT OR REPLACE INTO connector_marker VALUES (1, ?)').bind('app').run();
          await env.KV.put('marker', 'app');
          await env.FILES.put('marker', 'app');
          const connector = await env.ERP.storageProbe();
          return Response.json({ connector, app: { db: await env.DB.prepare('SELECT value FROM connector_marker').first('value'), kv: await env.KV.get('marker'), file: await (await env.FILES.get('marker')).text() } });
        }
        return Response.json(env.ERP ? await env.ERP.listCustomers() : { missing: true });
      } }`,
      [
        { type: "d1", name: "DB", database_name: "notes" },
        { type: "kv_namespace", name: "KV", id: "fixture" },
        { type: "r2_bucket", name: "FILES", bucket_name: "files" },
      ],
    );
    await agent();
    expect(JSON.parse((await appRequest(app.id)).stdout)).toEqual({ missing: true });
    expect(
      JSON.parse((await cli("connector", "unbind", "ERP", "--app", app.slug)).stdout),
    ).toMatchObject({
      state: "active",
      revision: 0,
      appliedRevision: 0,
      grants: {},
    });
    const container = `platform-fleet-${fleetId}`;

    const previous = (await execute("docker", ["inspect", "--format", "{{.Id}}", container]))
      .stdout;

    await cli("connector", "bind", "erp-fixture", "--as", "ERP", "--app", app.slug, "--no-wait");
    await agent();
    expect(JSON.parse((await appRequest(app.id)).stdout)).toEqual({
      customers: ["fixture"],
      sequence: 1,
      rootBinding: false,
    });
    expect(
      JSON.parse((await cli("connector", "bindings", "--app", app.slug)).stdout),
    ).toMatchObject({
      state: "active",
      grants: { ERP: { connector: "erp-fixture", entrypoint: "default" } },
    });

    expect(JSON.parse((await appRequest(app.id, "GET", "/storage")).stdout)).toEqual({
      connector: { db: "connector", kv: "connector", file: "connector" },
      app: { db: "app", kv: "app", file: "app" },
    });

    const secretFile = join(project, "secret.txt");

    const setSecret = async (value: string) => {
      await writeFile(secretFile, value);
      await cli(
        "connector",
        "secret",
        "put",
        "erp-fixture",
        "API_KEY",
        "--file",
        secretFile,
        "--no-wait",
      );
      await agent();
    };

    const secretProbe = async () =>
      z
        .object({
          connector: z.union([z.object({ value: z.string() }), z.object({ error: z.string() })]),
          exposed: z.boolean(),
        })
        .parse(JSON.parse((await appRequest(app.id, "GET", "/secret")).stdout));

    expect(await secretProbe()).toEqual({
      connector: { error: "Connector secret API_KEY is not configured" },
      exposed: false,
    });
    await setSecret("synthetic-first-key");
    expect(await secretProbe()).toEqual({
      connector: { value: "synthetic-first-key" },
      exposed: false,
    });
    const failedPublisher = join(state, "failed-secret-publisher");
    await writeFile(
      failedPublisher,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "celld 0.6.2\\n"; exit 0; fi\nprintf "Synthetic secret publication failure\\n" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    await writeFile(secretFile, "synthetic-rejected-key");
    await cli(
      "connector",
      "secret",
      "put",
      "erp-fixture",
      "API_KEY",
      "--file",
      secretFile,
      "--no-wait",
    );
    await expect(agent(undefined, undefined, failedPublisher)).rejects.toThrow(
      "Synthetic secret publication failure",
    );
    expect(await secretProbe()).toEqual({
      connector: { value: "synthetic-first-key" },
      exposed: false,
    });
    expect(JSON.parse((await cli("connector", "show", "erp-fixture")).stdout)).toMatchObject({
      state: "failed",
      secretRevision: 2,
      appliedSecretRevision: 1,
    });
    await setSecret("synthetic-rotated-key");
    expect(await secretProbe()).toEqual({
      connector: { value: "synthetic-rotated-key" },
      exposed: false,
    });
    await cli("connector", "secret", "delete", "erp-fixture", "API_KEY", "--no-wait");
    await agent();
    expect(await secretProbe()).toEqual({
      connector: { error: "Connector secret API_KEY is not configured" },
      exposed: false,
    });
    await setSecret("synthetic-current-key");

    const updated = source.replace("['fixture']", "['updated']");
    await writeFile(join(project, "worker.ts"), updated);
    await deploy();
    await agent();
    expect((await execute("docker", ["inspect", "--format", "{{.Id}}", container])).stdout).toBe(
      previous,
    );
    expect(JSON.parse((await appRequest(app.id)).stdout)).toEqual({
      customers: ["updated"],
      sequence: 2,
      rootBinding: false,
    });
    expect(await secretProbe()).toEqual({
      connector: { value: "synthetic-current-key" },
      exposed: false,
    });
    await stopServer();
    await execute("docker", ["restart", container]);
    await vi.waitFor(
      async () =>
        expect(JSON.parse((await appRequest(app.id)).stdout)).toMatchObject({
          customers: ["updated"],
          rootBinding: false,
        }),
      { timeout: 45000 },
    );
    expect(await secretProbe()).toEqual({
      connector: { value: "synthetic-current-key" },
      exposed: false,
    });
    await startServer();

    await cli(
      "connector",
      "bind",
      "erp-fixture",
      "--entrypoint",
      "ERP",
      "--as",
      "ERP",
      "--app",
      app.slug,
      "--no-wait",
    );
    await agent();

    // A saved revocation is not yet permission to remove a still-serving entrypoint.
    await cli("connector", "unbind", "ERP", "--app", app.slug, "--no-wait");

    const credentials = {
      authorization: `Bearer ${agentToken}`,
      "content-type": "application/json",
    };

    const revocation = contract.job.parse(
      await (
        await fetch(`${environment.configuration.PLATFORM_URL}/api/v1/agent/jobs/claim`, {
          method: "POST",
          headers: credentials,
          body: "{}",
        })
      ).json(),
    );

    expect(revocation.appId).toBe(app.id);
    expect(
      (
        await fetch(
          `${environment.configuration.PLATFORM_URL}/api/v1/agent/jobs/${revocation.id}/complete`,
          {
            method: "POST",
            headers: credentials,
            body: JSON.stringify({
              leaseToken: revocation.leaseToken,
              outcome: "failed",
              message: "Synthetic revocation failure",
            }),
          },
        )
      ).status,
    ).toBe(200);
    await writeFile(join(project, "worker.ts"), updated.replace("as ERP", "as Replacement"));
    await deploy();
    await expect(agent()).rejects.toThrow("Activate binding revocations");
    expect(JSON.parse((await appRequest(app.id)).stdout)).toMatchObject({ customers: ["updated"] });
    expect(JSON.parse((await cli("connector", "show", "erp-fixture")).stdout)).toMatchObject({
      state: "failed",
    });
    await cli("connector", "unbind", "ERP", "--app", app.slug, "--no-wait");
    await agent();
    expect(JSON.parse((await appRequest(app.id)).stdout)).toEqual({ missing: true });
    expect(
      JSON.parse((await cli("connector", "unbind", "ERP", "--app", app.slug)).stdout),
    ).toMatchObject({
      state: "active",
      revision: 3,
      appliedRevision: 3,
      grants: {},
    });
    await deploy();
    await agent();
    await cli(
      "connector",
      "bind",
      "erp-fixture",
      "--entrypoint",
      "Replacement",
      "--as",
      "ERP",
      "--app",
      app.slug,
      "--no-wait",
    );
    await agent();
    expect(JSON.parse((await appRequest(app.id)).stdout)).toMatchObject({ customers: ["updated"] });
    await request(`/apps/${app.id}`, "DELETE");
    await agent();
  }, 180000);

  it("isolates same-named secrets between connectors and preserves the other connector during rotation", async () => {
    const app = await createApp("connector-secret-isolation");
    const secretFile = join(state, "isolation-secret.txt");

    const setSecret = async (connector: string, name: string, value: string) => {
      await writeFile(secretFile, value);
      await cli("connector", "secret", "put", connector, name, "--file", secretFile, "--no-wait");
      await agent();
    };

    for (const [connector, binding, value] of [
      ["secret-left", "LEFT", "synthetic-left-key"],
      ["secret-right", "RIGHT", "synthetic-right-key"],
    ] as const) {
      const project = join(state, connector);
      await mkdir(project);
      await writeFile(
        join(project, "worker.ts"),
        `import { WorkerEntrypoint } from 'cloudflare:workers';
        export default class Connector extends WorkerEntrypoint {
          async read(name) {
            try { return { value: await this.env.WIDEFLEET_SECRETS.get(name) }; }
            catch (error) { return { error: error.message }; }
          }
        }`,
      );
      const config = join(project, "wrangler.jsonc");
      await writeFile(
        config,
        JSON.stringify({ name: connector, main: "worker.ts", compatibility_date: "2026-10-01" }),
      );
      await cli("connector", "deploy", "--config", config, "--no-wait");
      await agent();
      await setSecret(connector, "SHARED_NAME", value);
      await cli("connector", "bind", connector, "--as", binding, "--app", app.slug);
      await agent();
    }

    await setSecret("secret-left", "LEFT_ONLY", "synthetic-left-only-key");
    await publish(
      app.id,
      "secrets",
      `export default { async fetch(request, env) {
      const name = new URL(request.url).searchParams.get('name') ?? 'SHARED_NAME';
      return Response.json({ left: await env.LEFT.read(name), right: await env.RIGHT.read(name), exposed: 'WIDEFLEET_SECRETS' in env });
    } }`,
      [],
    );
    await agent();
    expect(JSON.parse((await appRequest(app.id)).stdout)).toEqual({
      left: { value: "synthetic-left-key" },
      right: { value: "synthetic-right-key" },
      exposed: false,
    });
    expect(JSON.parse((await appRequest(app.id, "GET", "/?name=LEFT_ONLY")).stdout)).toEqual({
      left: { value: "synthetic-left-only-key" },
      right: { error: "Connector secret LEFT_ONLY is not configured" },
      exposed: false,
    });
    await setSecret("secret-left", "SHARED_NAME", "synthetic-left-rotated-key");
    expect(JSON.parse((await appRequest(app.id)).stdout)).toEqual({
      left: { value: "synthetic-left-rotated-key" },
      right: { value: "synthetic-right-key" },
      exposed: false,
    });
    await request(`/apps/${app.id}`, "DELETE");
    await agent();
  }, 180000);

  it("installs a release outside the workspace, initializes an independent app, deploys it and saves a note and photo", async () => {
    appDirectory = join(state, "independent app");
    // The installed command must initialize offline, without a platform URL or token.
    await execute(cliExecutable, ["init", appDirectory], {
      cwd: state,
      env: { PATH: clientEnvironment.PATH },
    });
    await expect(execute(cliExecutable, ["init", appDirectory], { cwd: state })).rejects.toThrow(
      "already exists",
    );
    expect(await readFile(join(appDirectory, "package.json"), "utf8")).not.toContain("workspace:");
    expect(await readFile(join(appDirectory, ".gitignore"), "utf8")).toContain("node_modules/");
    await execute("pnpm", ["install", "--frozen-lockfile"], {
      cwd: appDirectory,
      env: clientEnvironment,
      maxBuffer: 8 * 1024 * 1024,
    });
    await execute("pnpm", ["check"], {
      cwd: appDirectory,
      env: clientEnvironment,
      maxBuffer: 8 * 1024 * 1024,
    });

    await cli("deploy", "--no-wait");
    const apps = z.array(contract.app).parse(JSON.parse((await cli("apps")).stdout));
    expect(apps).toHaveLength(1);
    const app = contract.app.parse(apps[0]);
    createdApps.push(app.id);
    hostnames.set(app.id, app.hostname);
    expect(app.slug).toBe("independent-app");
    expect(app.fleetId).toBe(fleetId);
    await agent();

    const history = z
      .array(contract.deployment)
      .parse(JSON.parse((await cli("history", app.id)).stdout));

    expect(history[0]?.status).toBe("succeeded");

    const curl = (...args: string[]) =>
      execute("docker", [
        "exec",
        `platform-fleet-${fleetId}`,
        "curl",
        "--silent",
        "--show-error",
        "--fail-with-body",
        "--max-time",
        "15",
        "-H",
        "X-Auth-Request-User: test-user",
        "-H",
        "X-Auth-Request-Preferred-Username: Starter Test",
        "-H",
        `Host: ${app.hostname}`,
        "-H",
        `Origin: http://${app.hostname}`,
        ...args,
      ]);

    const initial = await curl("http://127.0.0.1:8080/");
    expect(initial.stdout).toContain("Angemeldet als Starter Test");

    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8J0AAAAASUVORK5CYII=",
      "base64",
    );

    await writeFile(join(state, fleetId, "photo.png"), pixel);

    const saved = await curl(
      "--form",
      "message=Persisted starter note",
      "--form",
      "photo=@/state/photo.png;type=image/png",
      "http://127.0.0.1:8080/",
    );

    expect(
      z
        .object({ type: z.literal("success"), status: z.literal(200) })
        .parse(JSON.parse(saved.stdout)),
    ).toMatchObject({ status: 200 });
    const updated = await curl("http://127.0.0.1:8080/");
    expect(updated.stdout).toContain("Persisted starter note");
    const photo = z.string().parse(/src="(\/photos\/[a-f0-9-]+)"/.exec(updated.stdout)?.[1]);

    const fetched = await curl(
      "-o",
      "/state/saved.png",
      "-w",
      "%{http_code}",
      `http://127.0.0.1:8080${photo}`,
    );

    expect(fetched.stdout).toBe("200");
    expect(await readFile(join(state, fleetId, "saved.png"))).toEqual(pixel);

    // A fresh checkout with the same name updates the same app without a local ID binding.
    const checkout = join(state, "fresh checkout");
    await execute(cliExecutable, ["init", checkout], {
      cwd: state,
      env: { PATH: clientEnvironment.PATH },
    });
    await cp(join(appDirectory, "wrangler.jsonc"), join(checkout, "wrangler.jsonc"));
    await execute("pnpm", ["install", "--frozen-lockfile"], {
      cwd: checkout,
      env: clientEnvironment,
      maxBuffer: 8 * 1024 * 1024,
    });
    appDirectory = checkout;
    await Promise.all([
      cli("deploy"),
      (async () => {
        await vi.waitFor(
          async () => {
            const deployments = z
              .array(contract.deployment)
              .parse(await (await request(`/apps/${app.id}/deployments`, "GET")).json());

            expect(deployments).toHaveLength(2);
            expect(deployments[0]?.status).toBe("queued");
          },
          { timeout: 20_000 },
        );
        await agent();
      })(),
    ]);
    expect((await curl("http://127.0.0.1:8080/")).stdout).toContain("Persisted starter note");
    expect(z.array(contract.app).parse(JSON.parse((await cli("apps")).stdout))).toHaveLength(1);

    const previewResult = contract.deployment
      .extend({ url: z.url() })
      .parse(
        JSON.parse(
          (await cli("preview", "--name", "review", "--skip-build", "--no-wait", "--json")).stdout,
        ),
      );

    const preview = contract.app.parse(
      await (await request(`/apps/${previewResult.appId}`, "GET")).json(),
    );

    createdApps.push(preview.id);
    hostnames.set(preview.id, preview.hostname);
    expect(preview.parentId).toBe(app.id);
    expect(preview.hostname).toBe(`review.${app.hostname}`);
    expect(previewResult.url).toBe(preview.url);
    await agent();

    const previewPage = await execute("docker", [
      "exec",
      `platform-fleet-${fleetId}`,
      "curl",
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--max-time",
      "15",
      "-H",
      `Host: ${preview.hostname}`,
      "-H",
      "X-Auth-Request-User: test-user",
      "-H",
      "X-Auth-Request-Preferred-Username: Preview Test",
      "http://127.0.0.1:8080/",
    ]);

    expect(previewPage.stdout).toContain("Angemeldet als Preview Test");
    expect(previewPage.stdout).not.toContain("Persisted starter note");
    expect(
      JSON.parse(await readFile(join(state, `routes/platform-app-${preview.id}.yaml`), "utf8")),
    ).toMatchObject({
      http: {
        routers: {
          [`platform-app-${preview.id}`]: {
            tls: { certResolver: "letsencrypt", domains: [{ main: `*.${app.hostname}` }] },
          },
        },
      },
    });
    expect((await curl("http://127.0.0.1:8080/")).stdout).toContain("Persisted starter note");
    await cli("delete", preview.id, "--yes");
    await agent();
    await cli("delete", app.id, "--yes");
    await agent();
    expect(z.array(contract.app).parse(JSON.parse((await cli("apps")).stdout))).toHaveLength(0);
  }, 360_000);

  it("bundles and deploys Node ESM imports, CommonJS builtins and Worker package exports with nodejs_compat", async () => {
    appDirectory = join(state, "node compat app");
    const dependency = join(appDirectory, "node_modules/compat-fixture");
    await mkdir(dependency, { recursive: true });
    await mkdir(join(appDirectory, "public"));
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "compat-fixture",
        exports: { workerd: "./worker.cjs", browser: "./wrong.js", default: "./wrong.js" },
      }),
    );
    await writeFile(join(dependency, "wrong.js"), 'throw new Error("Incorrect export condition");');
    await writeFile(
      join(dependency, "worker.cjs"),
      `const { basename } = require("path");
       const { Buffer } = require("node:buffer");
       exports.value = () => Buffer.from(basename("/app/cjs-ok")).toString();
       exports.load = (name) => require(name);`,
    );
    await writeFile(
      join(appDirectory, "worker.js"),
      `import { AsyncLocalStorage } from "node:async_hooks";
       import { createHash } from "node:crypto";
       import { Buffer } from "buffer";
       import { Readable } from "node:stream";
       import { join } from "path/posix";
       import dependency from "compat-fixture";

       const context = new AsyncLocalStorage();
       export default { fetch() {
         return context.run("request-context", async () => {
           let streamed = "";
           for await (const chunk of Readable.from(["node", "-stream"])) streamed += chunk;
           let missingCode;
           try { dependency.load("missing-fixture-module"); }
           catch (error) { missingCode = error.code; }
           return Response.json({
             context: context.getStore(),
             base64: Buffer.from("widefleet").toString("base64"),
             sha256: createHash("sha256").update("abc").digest("hex"),
             path: join("app", "data"),
             commonjs: dependency.value(),
             dynamicBuiltin: dependency.load("node:util").format("%s:%d", "ok", 3),
             globalBuffer: globalThis.Buffer.from("global").toString(),
             missingCode,
             streamed,
           });
         });
       } };`,
    );

    const configure = (flags: string[]) =>
      writeFile(
        join(appDirectory, "wrangler.jsonc"),
        JSON.stringify({
          main: "worker.js",
          compatibility_date: "2026-10-01",
          compatibility_flags: flags,
          assets: { directory: "public", binding: "ASSETS" },
        }),
      );

    const app = await createApp("node-compat");
    await configure(["nodejs_als"]);
    await expect(cli("deploy", app.id, "--skip-build", "--no-wait")).rejects.toThrow(
      "Worker bundling failed",
    );
    await configure(["unsupported_flag"]);
    await expect(cli("deploy", app.id, "--skip-build", "--no-wait")).rejects.toThrow(
      "Supported compatibility flags",
    );
    await configure(["nodejs_compat", "nodejs_compat"]);
    await expect(cli("deploy", app.id, "--skip-build", "--no-wait")).rejects.toThrow(
      "Compatibility flags must be unique",
    );
    expect(
      z.array(contract.deployment).parse(JSON.parse((await cli("history", app.id)).stdout)),
    ).toHaveLength(0);

    await configure(["nodejs_compat"]);
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await agent();
    expect(
      z.array(contract.deployment).parse(JSON.parse((await cli("history", app.id)).stdout))[0]
        ?.status,
    ).toBe("succeeded");
    expect(JSON.parse((await appRequest(app.id)).stdout)).toEqual({
      context: "request-context",
      base64: "d2lkZWZsZWV0",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      path: "app/data",
      commonjs: "cjs-ok",
      dynamicBuiltin: "ok:3",
      globalBuffer: "global",
      missingCode: "MODULE_NOT_FOUND",
      streamed: "node-stream",
    });
    await cli("delete", app.id, "--yes");
    await agent();
  }, 180_000);

  it("deploys KV, queues and cron and recovers interrupted event activation", async () => {
    appDirectory = join(state, "capabilities app");
    await mkdir(join(appDirectory, "public"), { recursive: true });
    await cp(join(root, "packages/app-runtime/fixtures/app.ts"), join(appDirectory, "worker.ts"));
    await writeFile(
      join(appDirectory, "wrangler.jsonc"),
      JSON.stringify({
        main: "worker.ts",
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        assets: { directory: "public", binding: "ASSETS" },
        d1_databases: [{ binding: "DB", database_name: "fixture" }],
        r2_buckets: [{ binding: "FILES", bucket_name: "fixture" }],
        kv_namespaces: [{ binding: "KV", id: "fixture" }],
        triggers: { crons: ["* * * * *"] },
        queues: {
          producers: [{ binding: "JOBS", queue: "fixture" }],
          consumers: [
            {
              queue: "fixture",
              max_batch_size: 1,
              max_batch_timeout: 1,
              max_retries: 1,
              retry_delay: 1,
              dead_letter_queue: "dead",
            },
            { queue: "dead", max_batch_size: 1, max_batch_timeout: 1 },
          ],
        },
      }),
    );
    const app = await createApp("capabilities");
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await agent();

    const read = async (path: string) =>
      z.json().parse(JSON.parse((await appRequest(app.id, "GET", path)).stdout));

    expect(await read("/?operation=kv")).toMatchObject({ bytes: [0, 128, 255], count: 3 });
    await read("/?operation=enqueue");
    await expect
      .poll(() => read("/?operation=queue-result"), { timeout: 20000 })
      .toMatchObject({ implicit: true, retried: true, dead: true, background: true });

    const config = z
      .record(z.string(), z.json())
      .parse(JSON.parse(await readFile(join(appDirectory, "wrangler.jsonc"), "utf8")));

    config["triggers"] = { crons: [] };
    config["queues"] = { producers: [{ binding: "JOBS", queue: "fixture" }], consumers: [] };
    await writeFile(join(appDirectory, "wrangler.jsonc"), JSON.stringify(config));
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await agent();

    for (const queue of ["fixture", "dead"]) {
      const identity = `r${createHash("sha256").update(`${app.id}/queue/${queue}`).digest("hex").slice(0, 40)}`;

      const attachment = await s3.send(
        new GetObjectCommand({
          Bucket: environment.configuration.S3_BUCKET,
          Key: `fleets/${fleetId}/deploy/queues/${identity}/consumer.json`,
        }),
      );

      expect(JSON.parse((await attachment.Body?.transformToString()) ?? "{}")).not.toHaveProperty(
        "consumer",
      );
    }

    // Hold readiness after the native reload, before selecting the app snapshot.
    // This exposes both consumer activation ordering and interrupted recovery.
    const currentPackages = await installed();

    const wrapper = `
      import runtime from './fixture-original.js';
      export * from './fixture-original.js';
      export default { ...runtime, async fetch(request, env, ctx) {
        if (request.headers.has('x-widefleet-candidate') && await env.WIDEFLEET_PACKAGES.get('_fixture/hold')) {
          await env.WIDEFLEET_PACKAGES.put('_fixture/waiting', 'yes');
          while (await env.WIDEFLEET_PACKAGES.get('_fixture/hold')) await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (new URL(request.url).pathname === '/fixture/crons')
          return Response.json(JSON.parse(env.WIDEFLEET_CONFIGURATION).crons);
        if (new URL(request.url).pathname === '/fixture/pending-resource') {
          return Response.json('${`B_r${createHash("sha256").update(`${app.id}/kv/only-candidate`).digest("hex").slice(0, 40)}`}' in env);
        }
        const response = await runtime.fetch(request, env, ctx);
        if (new URL(request.url).pathname === '/.well-known/widefleet/runtime' && response.ok) return Response.json({ runtimeVersion: '0.1.98' });
        return response;
      } };
    `;

    await manageRuntime("/runtime", await wrappedRuntime("0.1.98", wrapper));
    await agent();
    const marker = (name: string) => `fleets/${fleetId}/r2/widefleet-packages/_fixture/${name}`;

    const hold = () =>
      s3.send(
        new PutObjectCommand({
          Bucket: environment.configuration.S3_BUCKET,
          Key: marker("hold"),
          Body: "yes",
        }),
      );

    const release = () =>
      s3.send(
        new DeleteObjectsCommand({
          Bucket: environment.configuration.S3_BUCKET,
          Delete: { Objects: ["hold", "waiting"].map((name) => ({ Key: marker(name) })) },
        }),
      );

    const waiting = () =>
      vi.waitFor(
        async () => {
          expect(
            (
              await s3.send(
                new GetObjectCommand({
                  Bucket: environment.configuration.S3_BUCKET,
                  Key: marker("waiting"),
                }),
              )
            ).Body,
          ).toBeDefined();
        },
        { timeout: 15000 },
      );

    config["triggers"] = { crons: ["* * * * *"] };
    await writeFile(join(appDirectory, "wrangler.jsonc"), JSON.stringify(config));
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await agent();
    expect(await read("/fixture/crons")).toEqual({ "* * * * *": [app.hostname] });

    config["triggers"] = { crons: [] };
    await writeFile(join(appDirectory, "wrangler.jsonc"), JSON.stringify(config));
    await hold();
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    const cronActivation = agent();
    void cronActivation.catch(() => undefined);

    try {
      await waiting();
      // Removing only a cron must not change the active scheduler's host map
      // before the candidate has passed evaluation.
      expect(await read("/fixture/crons")).toEqual({ "* * * * *": [app.hostname] });
    } finally {
      await release();
      await cronActivation;
    }

    expect(await read("/fixture/crons")).toEqual({});

    await appRequest(app.id, "POST", "/?operation=queue-probe");
    await writeFile(
      join(appDirectory, "worker.ts"),
      (await readFile(join(appDirectory, "worker.ts"), "utf8")).replace(
        '"probe-old"',
        '"probe-new"',
      ),
    );
    config["queues"] = {
      producers: [{ binding: "JOBS", queue: "fixture" }],
      consumers: [{ queue: "fixture", max_batch_size: 1, max_batch_timeout: 1 }],
    };
    await writeFile(join(appDirectory, "wrangler.jsonc"), JSON.stringify(config));
    await hold();
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    const activation = agent();
    void activation.catch(() => undefined);

    try {
      await waiting();
      const identity = `r${createHash("sha256").update(`${app.id}/queue/fixture`).digest("hex").slice(0, 40)}`;

      const attachment = await s3.send(
        new GetObjectCommand({
          Bucket: environment.configuration.S3_BUCKET,
          Key: `fleets/${fleetId}/deploy/queues/${identity}/consumer.json`,
        }),
      );

      expect(JSON.parse((await attachment.Body?.transformToString()) ?? "{}")).not.toHaveProperty(
        "consumer",
      );
      expect(await read("/?operation=queue-probe")).toBeNull();
    } finally {
      await release();
      await activation;
    }

    try {
      await expect
        .poll(() => read("/?operation=queue-probe"), { timeout: 20000 })
        .toBe("probe-new");
    } catch (cause) {
      const identity = `r${createHash("sha256").update(`${app.id}/queue/fixture`).digest("hex").slice(0, 40)}`;

      const info = await execute("docker", [
        "exec",
        `platform-fleet-${fleetId}`,
        "celld",
        "queue",
        "info",
        identity,
        "--bucket",
        `s3://${environment.configuration.S3_BUCKET}/fleets/${fleetId}`,
        "--endpoint",
        "http://internal-app-platform-test-rustfs-1:9000",
        "--json",
      ]);

      const logs = await execute("docker", ["logs", "--tail", "100", `platform-fleet-${fleetId}`]);
      throw new Error(`Queue state: ${info.stdout}\n${logs.stdout}\n${logs.stderr}`, { cause });
    }

    const consumerConfiguration = config["queues"];
    config["kv_namespaces"] = [
      { binding: "KV", id: "fixture" },
      { binding: "TEMP", id: "only-candidate" },
    ];
    config["queues"] = { producers: [{ binding: "JOBS", queue: "fixture" }], consumers: [] };
    await writeFile(join(appDirectory, "wrangler.jsonc"), JSON.stringify(config));
    await hold();
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    const interrupted = agent();
    void interrupted.catch(() => undefined);

    try {
      await waiting();
      expect(await read("/fixture/pending-resource")).toBe(true);

      if (!activeAgent) throw new Error("Missing agent process");
      activeAgent.kill("SIGKILL");
      await expect(interrupted).rejects.toThrow();

      const [job] = await environment.database.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.appId, app.id), eq(jobs.state, "running")));

      if (!job) throw new Error("Missing interrupted job");

      const completed = await fetch(
        `${environment.configuration.PLATFORM_URL}/api/v1/agent/jobs/${job.id}/complete`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            leaseToken: job.leaseToken,
            outcome: "failed",
            message: "Synthetic interruption after native reload",
          }),
        },
      );

      expect(completed.status).toBe(200);
    } finally {
      await release();
      await interrupted.catch(() => undefined);
    }

    config["queues"] = consumerConfiguration;
    config["kv_namespaces"] = [{ binding: "KV", id: "fixture" }];
    await writeFile(join(appDirectory, "wrangler.jsonc"), JSON.stringify(config));
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    const recovered = await agent();
    expect(recovered.stdout + recovered.stderr).not.toContain(
      "Publishing the shared fleet's native configuration",
    );
    expect(await read("/fixture/pending-resource")).toBe(false);
    await manageRuntime("/runtime", currentPackages.runtime);
    await agent();

    // Reattach a consumer so deletion also proves removal of a live subscription.
    config["triggers"] = { crons: ["* * * * *"] };
    config["queues"] = {
      producers: [{ binding: "JOBS", queue: "fixture" }],
      consumers: [{ queue: "fixture" }],
    };
    await writeFile(join(appDirectory, "wrangler.jsonc"), JSON.stringify(config));
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await agent();
    await cli("delete", app.id, "--yes");
    await agent();

    const identity = `r${createHash("sha256").update(`${app.id}/queue/fixture`).digest("hex").slice(0, 40)}`;

    const detached = await s3.send(
      new GetObjectCommand({
        Bucket: environment.configuration.S3_BUCKET,
        Key: `fleets/${fleetId}/deploy/queues/${identity}/consumer.json`,
      }),
    );

    expect(JSON.parse((await detached.Body?.transformToString()) ?? "{}")).not.toHaveProperty(
      "consumer",
    );

    // A connector DO keeps the cell runtime alive after the last app cron is
    // removed. Its old cron cell must still be startable to retire the alarm;
    // celld otherwise retries restoration until local storage fills up.
    const retired = await execute("docker", [
      "exec",
      `platform-fleet-${fleetId}`,
      "curl",
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      "10",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      `http://platform-fleet-${fleetId}:8081/do/.cron:widefleet`,
    ]);

    expect(retired.stdout).toBe("204");
    await expect(appRequest(app.id)).rejects.toThrow("404");
  }, 180000);

  it("enforces browser network grants through the deployed app and real Traefik", async () => {
    appDirectory = join(state, "browser app");
    await mkdir(join(appDirectory, "public"), { recursive: true });
    await cp(
      join(root, "packages/app-runtime/fixtures/browser.ts"),
      join(appDirectory, "worker.ts"),
    );
    await writeFile(
      join(appDirectory, "public/static.html"),
      "<!doctype html><title>Static network fixture</title><p>Static network fixture</p>",
    );
    await writeFile(
      join(appDirectory, "wrangler.jsonc"),
      JSON.stringify({
        main: "worker.ts",
        compatibility_date: "2026-10-01",
        assets: { directory: "public", binding: "ASSETS" },
        kv_namespaces: [{ binding: "KV", id: "browser-fixture" }],
      }),
    );
    const app = await createApp("browser-network");
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await agent();
    const edgeName = `widefleet-browser-test-${crypto.randomUUID()}`;
    const routePath = join(state, "routes/browser-fixture.yaml");
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

    try {
      // Keep the generated app router and trusted runtime CSP intact. Authentication
      // has separate edge coverage; this fixture supplies an authenticated route.
      await writeFile(
        routePath,
        JSON.stringify({
          http: {
            middlewares: {
              "app-auth": { headers: { customRequestHeaders: { "x-fixture": "yes" } } },
              "fixture-host": {
                headers: {
                  customRequestHeaders: { Host: app.hostname, "X-Forwarded-Host": app.hostname },
                },
              },
            },
            routers: {
              resources: {
                middlewares: ["fixture-host"],
                rule: "Host(`connect.localhost`) || Host(`images.localhost`) || Host(`fonts.localhost`) || Host(`denied.localhost`)",
                entryPoints: ["websecure"],
                tls: {},
                service: `platform-app-${app.id}@file`,
              },
            },
          },
        }),
      );
      await execute("docker", [
        "run",
        "-d",
        "--name",
        edgeName,
        "--network",
        `platform-fleet-${fleetId}`,
        "--publish",
        "127.0.0.1::8443",
        "--volume",
        `${state}/routes:/routes:ro`,
        "traefik:v3.7.13@sha256:24841fe2de7304c149343d877d2923b4c8800a38ba015dea9174c23b20e344a0",
        "--entrypoints.websecure.address=:8443",
        "--providers.file.directory=/routes",
        "--providers.file.watch=true",
        "--providers.providersThrottleDuration=100ms",
      ]);
      const published = (await execute("docker", ["port", edgeName, "8443/tcp"])).stdout.trim();
      const port = new URL(`https://${published}`).port;
      const origin = `https://${app.hostname}:${port}`;

      const destinations = [
        { host: "connect", grant: "connect" },
        { host: "images", grant: "image" },
        { host: "fonts", grant: "font" },
        { host: "denied", grant: "none" },
      ].map((destination) => ({
        ...destination,
        origin: `https://${destination.host}.localhost:${port}`,
      }));

      browser = await chromium.launch({
        args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
      });
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const resourceEvents: string[] = [];
      page.on("response", (response) => {
        if (new URL(response.url()).pathname.startsWith("/resource/"))
          resourceEvents.push(`${response.status()} ${response.url()}`);
      });
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).pathname.startsWith("/resource/"))
          resourceEvents.push(`${request.failure()?.errorText} ${request.url()}`);
      });
      await vi.waitFor(async () => expect((await page.goto(origin))?.status()).toBe(200), {
        timeout: 20000,
      });

      const probe = async (phase: string, grants: boolean) => {
        const violations = await page.evaluate(
          async ({ destinations, phase }) => {
            const violations: string[] = [];

            const observe = (event: SecurityPolicyViolationEvent) => {
              violations.push(`${event.effectiveDirective}:${event.blockedURI}`);
            };

            document.addEventListener("securitypolicyviolation", observe);

            try {
              await Promise.all(
                destinations.flatMap((destination) =>
                  ["connect", "image", "font"].map(async (kind) => {
                    const url = `${destination.origin}/resource/${kind}?phase=${phase}&destination=${new URL(destination.origin).host}`;

                    if (kind === "connect") await fetch(url).catch(() => null);
                    else if (kind === "font")
                      await new FontFace(`Fixture-${destination.host}`, `url(${url})`)
                        .load()
                        .catch(() => null);
                    else
                      await new Promise<void>((resolve) => {
                        const image = new Image();
                        image.onload = () => resolve();
                        image.onerror = () => resolve();
                        image.src = url;
                      });
                  }),
                ),
              );
              await new Promise(requestAnimationFrame);

              return violations.sort();
            } finally {
              document.removeEventListener("securitypolicyviolation", observe);
            }
          },
          { destinations, phase },
        );

        const expectedBlocked = destinations.flatMap((destination) =>
          ["connect", "image", "font"].flatMap((kind) =>
            grants && destination.grant !== "none"
              ? []
              : [
                  `${kind === "image" ? "img" : kind}-src:${destination.origin}/resource/${kind}?phase=${phase}&destination=${new URL(destination.origin).host}`,
                ],
          ),
        );

        expect(violations).toEqual(expectedBlocked.sort());

        const received = z
          .array(z.string())
          .parse(JSON.parse((await appRequest(app.id, "GET", `/observed?phase=${phase}`)).stdout));

        expect(received.sort(), resourceEvents.join("\n")).toEqual(
          grants
            ? destinations
                .flatMap((destination) =>
                  destination.grant === "none"
                    ? []
                    : ["connect", "image", "font"].map(
                        (kind) => `${phase}:${new URL(destination.origin).host}:${kind}`,
                      ),
                )
                .sort()
            : [],
        );
      };

      const response = await page.reload();
      const initialCsp = response?.headers()["content-security-policy"];
      expect(initialCsp).toContain("default-src 'self'");
      expect(initialCsp).not.toContain("default-src *");
      await probe("initial", false);

      const browserOrigins = destinations.flatMap((destination) =>
        destination.grant === "none" ? [] : [destination.origin],
      );

      await cli("network", "allow", ...browserOrigins, "--browser", "--app", app.slug, "--no-wait");
      await agent();
      await vi.waitFor(
        async () => {
          const response = await page.reload();
          expect(response?.headers()["content-security-policy"]).toContain(
            `connect-src 'self' ${[...browserOrigins].sort().join(" ")};`,
          );
        },
        { timeout: 10000 },
      );
      await probe("granted", true);
      const staticResponse = await page.goto(`${origin}/static.html`);
      expect(staticResponse?.status()).toBe(200);
      expect(staticResponse?.headers()["content-security-policy"]).toContain("default-src 'self'");
      await probe("static", true);

      await cli(
        "network",
        "allow",
        ...destinations.map((destination) => destination.origin),
        "--app",
        app.slug,
        "--no-wait",
      );
      await agent();
      await cli("network", "deny", ...browserOrigins, "--browser", "--app", app.slug, "--no-wait");
      await agent();
      await vi.waitFor(
        async () => {
          const response = await page.goto(origin);
          expect(response?.headers()["content-security-policy"]).toBe(initialCsp);
        },
        { timeout: 10000 },
      );
      await probe("revoked", false);
    } finally {
      await browser?.close();
      await execute("docker", ["rm", "-f", edgeName]).catch(() => undefined);
      await rm(routePath, { force: true });
    }

    await cli("delete", app.id, "--yes");
    await agent();
  }, 180000);

  it("deploys and reloads, isolates preview data, rolls back code, boots without the control plane and removes an app and its previews without deleting unrelated apps", async () => {
    const app = await createApp("runtime-notes");
    const first = await publish(app.id, "one");
    await agent();
    expect(await appState(app.id, "POST")).toEqual({
      version: "one",
      count: 1,
      file: "saved-file",
    });
    expect((await appRequest(app.id, "GET", "/note.txt")).stdout).toBe("static asset");

    const nativeBefore = await s3.send(
      new GetObjectCommand({
        Bucket: environment.configuration.S3_BUCKET,
        Key: `fleets/${fleetId}/deploy/current.json`,
      }),
    );

    const pointerBefore = await nativeBefore.Body?.transformToString();
    await publish(app.id, "two");
    // Queue a permission edit before the new code is active. Its later job must
    // pick up that code, not roll back to the deployment active at edit time.
    await cli("network", "allow", "https://api.example.test", "--app", app.slug, "--no-wait");
    await agent();
    await agent();
    expect(
      contract.networkState.parse(JSON.parse((await cli("network", "--app", app.slug)).stdout)),
    ).toMatchObject({
      state: "active",
      appliedRevision: 1,
      policy: { backend: ["https://api.example.test"] },
    });
    expect(await appState(app.id)).toEqual({ version: "two", count: 1, file: "saved-file" });

    const nativeAfter = await s3.send(
      new GetObjectCommand({
        Bucket: environment.configuration.S3_BUCKET,
        Key: `fleets/${fleetId}/deploy/current.json`,
      }),
    );

    expect(await nativeAfter.Body?.transformToString()).toBe(pointerBefore);
    const preview = await createApp("runtime-preview", app.id, "review");
    expect(preview.hostname).toBe(`review.${app.hostname}`);
    await publish(preview.id, "preview");
    await agent();
    expect(await appState(preview.id)).toEqual({ version: "preview", count: 0, file: null });
    expect(
      contract.networkState.parse(JSON.parse((await cli("network", "--app", preview.slug)).stdout))
        .policy,
    ).toEqual({ backend: [], browser: [] });
    expect(await appState(preview.id, "POST")).toEqual({
      version: "preview",
      count: 1,
      file: "saved-file",
    });

    const rollback = await fetch(
      `${environment.configuration.PLATFORM_URL}/api/v1/apps/${app.id}/rollback`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          origin: environment.configuration.PLATFORM_URL,
          "x-forwarded-proto": "http",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ artifactId: first.artifactId }),
      },
    );

    expect(rollback.status).toBe(200);
    await agent();
    expect(await appState(app.id)).toEqual({ version: "one", count: 1, file: "saved-file" });
    expect(
      JSON.parse((await appRequest(app.id, "GET", "/.well-known/widefleet/ready")).stdout),
    ).toMatchObject({ networkRevision: 1 });
    expect(
      contract.networkState.parse(JSON.parse((await cli("network", "--app", app.slug)).stdout)),
    ).toMatchObject({
      state: "active",
      revision: 1,
      appliedRevision: 1,
      policy: { backend: ["https://api.example.test"] },
    });
    expect(await readFile(join(state, "routes", `platform-app-${app.id}.yaml`), "utf8")).toContain(
      "app-auth@file",
    );
    await stopServer();
    await execute("docker", ["restart", `platform-fleet-${fleetId}`]);
    await expect
      .poll(
        async () => {
          try {
            return await appState(app.id);
          } catch {
            return null;
          }
        },
        { timeout: 45_000 },
      )
      .toEqual({ version: "one", count: 1, file: "saved-file" });
    await startServer();
    // The original R2 bucket must also be cleaned after it is no longer bound.
    await publish(app.id, "new-bucket", undefined, [
      {
        type: "d1",
        name: "DB",
        database_name: "notes",
        database_id: "same-logical-id-in-every-fixture-app",
      },
      { type: "r2_bucket", name: "FILES", bucket_name: "replacement" },
    ]);
    await agent();
    expect(await appState(app.id, "POST")).toMatchObject({ count: 2, file: "saved-file" });
    const unrelated = await createApp("runtime-unrelated");
    await publish(unrelated.id, "unrelated");
    await agent();
    expect(await appState(unrelated.id, "POST")).toEqual({
      version: "unrelated",
      count: 1,
      file: "saved-file",
    });
    // Deletion must not read or parse another app's unrelated deployment history.
    await s3.send(
      new PutObjectCommand({
        Bucket: environment.configuration.S3_BUCKET,
        Key: `fleets/${fleetId}/r2/widefleet-packages/versions/${unrelated.id}/unreadable.json`,
        Body: "unrelated history fixture",
      }),
    );
    await request(`/apps/${app.id}`, "DELETE");

    for (const target of [app, preview]) {
      expect(
        contract.app.parse(await (await request(`/apps/${target.id}`, "GET")).json()).state,
      ).toBe("deleting");
    }

    await agent();
    await expect(request(`/apps/${preview.id}`, "GET")).rejects.toThrow("404");
    expect(contract.app.parse(await (await request(`/apps/${app.id}`, "GET")).json()).state).toBe(
      "deleting",
    );
    await agent();
    const packages = `fleets/${fleetId}/r2/widefleet-packages`;

    for (const target of [app, preview]) {
      for (const prefix of [
        `apps/${target.id}/`,
        `${packages}/hosts/${target.hostname}.json`,
        `${packages}/apps/${target.id}/`,
        `${packages}/versions/${target.id}/`,
        ...["files", "replacement"].map(
          (bucket) =>
            `fleets/${fleetId}/r2/r${createHash("sha256").update(`${target.id}/r2/${bucket}`).digest("hex").slice(0, 40)}/`,
        ),
      ]) {
        expect(
          (
            await s3.send(
              new ListObjectsV2Command({
                Bucket: environment.configuration.S3_BUCKET,
                Prefix: prefix,
              }),
            )
          ).Contents ?? [],
        ).toHaveLength(0);
      }

      await expect(
        readFile(join(state, "routes", `platform-app-${target.id}.yaml`)),
      ).rejects.toThrow("ENOENT");
      await expect(request(`/apps/${target.id}`, "GET")).rejects.toThrow("404");
      await expect(appRequest(target.id)).rejects.toThrow("404");
    }

    const unrelatedHistory = await s3.send(
      new GetObjectCommand({
        Bucket: environment.configuration.S3_BUCKET,
        Key: `${packages}/versions/${unrelated.id}/unreadable.json`,
      }),
    );

    expect(await unrelatedHistory.Body?.transformToString()).toBe("unrelated history fixture");
    expect(await appState(unrelated.id)).toEqual({
      version: "unrelated",
      count: 1,
      file: "saved-file",
    });
  }, 180_000);
  it("runs explicit flat and Drizzle v1 migrations with atomic failures and durable retries", async () => {
    const app = await createApp("migration-runtime");
    const isolated = await createApp("migration-isolated");
    const databaseId = "é".repeat(65);

    const binding = contract.workerBinding.parse({
      type: "d1",
      name: "DB",
      database_name: "notes",
      database_id: databaseId,
    });

    const source = `export default { async fetch(request, env) {
      const tables = (await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()).results.map(row => row.name);
      const items = tables.includes('items') ? (await env.DB.prepare('SELECT id, note FROM items ORDER BY id').all()).results : [];
      const history = tables.includes('d1_migrations') ? (await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results : [];
      return Response.json({ tables, items, history });
    } };`;

    const deployed = await publish(app.id, "migration", source, [binding]);
    await agent();
    await publish(isolated.id, "isolated", source, [binding]);
    await agent();
    const project = join(state, "migration-project");
    await mkdir(join(project, "migrations"), { recursive: true });

    const config = {
      name: app.slug,
      d1_databases: [
        {
          binding: "DB",
          database_name: "notes",
          database_id: databaseId,
          migrations_pattern: "migrations/**/*.sql",
        },
      ],
    };

    await writeFile(join(project, "wrangler.jsonc"), JSON.stringify(config));
    await writeFile(
      join(project, "migrations/2_initial.sql"),
      "CREATE TABLE items (id INTEGER PRIMARY KEY, note TEXT NOT NULL);\nINSERT INTO items VALUES (1, 'initial');",
    );
    await writeFile(
      join(project, "migrations/10_next.sql"),
      "INSERT INTO items VALUES (2, 'next');\n-- trailing comment without a newline",
    );

    const inspect = async (id = app.id) =>
      z
        .object({
          tables: z.array(z.string()),
          items: z.array(z.object({ id: z.number(), note: z.string() })),
          history: z.array(z.object({ name: z.string() })),
        })
        .parse(JSON.parse((await appRequest(id)).stdout));

    const migrate = async (
      action: "list" | "apply",
      options: {
        loseCompletion?: boolean;
        failHeartbeat?: boolean;
        damageArtifact?: "missing" | "truncated" | "oversized" | "modified";
      } = {},
    ) => {
      let commandFailure: Error | undefined;

      const operation = cli(
        "migrations",
        action,
        "DB",
        "--config",
        join(project, "wrangler.jsonc"),
      ).catch((cause: unknown) => {
        commandFailure = cause instanceof Error ? cause : new Error("Migration CLI failed");

        return commandFailure;
      });

      const queued = await vi.waitFor(
        async () => {
          if (commandFailure) throw commandFailure;

          const pending = await environment.database.db
            .select()
            .from(jobs)
            .where(
              and(eq(jobs.appId, app.id), eq(jobs.kind, "migrations"), eq(jobs.state, "queued")),
            );

          expect(pending).toHaveLength(1);
          const [job] = pending;

          if (!job) throw new Error("Missing migration job");

          return job;
        },
        { timeout: 10000 },
      );

      const reference = contract.migrationArtifact.parse(queued.migration);

      const object = {
        Bucket: environment.configuration.S3_BUCKET,
        Key: `apps/${app.id}/migrations/${reference.sha256}`,
      };

      let original: Uint8Array | undefined;

      if (options.damageArtifact) {
        const stored = await s3.send(new GetObjectCommand(object));
        original = await stored.Body?.transformToByteArray();

        if (!original) throw new Error("Missing migration artifact");
        expect(original.byteLength).toBe(reference.size);
        expect(createHash("sha256").update(original).digest("hex")).toBe(reference.sha256);

        if (options.damageArtifact === "missing") {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: object.Bucket,
              Delete: { Objects: [{ Key: object.Key }] },
            }),
          );
        } else {
          const changed =
            options.damageArtifact === "truncated"
              ? original.subarray(0, original.length - 1)
              : options.damageArtifact === "oversized"
                ? Buffer.concat([original, Buffer.from(" ")])
                : Buffer.from(Buffer.from(original).toString().replace("'initial'", "'altered'"));

          await s3.send(new PutObjectCommand({ ...object, Body: changed }));
        }
      }

      rejectCompletion = options.loseCompletion ?? false;
      rejectHeartbeat = options.failHeartbeat ?? false;

      try {
        await agent().catch(() => undefined);
      } finally {
        rejectCompletion = false;
        rejectHeartbeat = false;

        if (original) await s3.send(new PutObjectCommand({ ...object, Body: original }));
      }

      if (options.loseCompletion) {
        await environment.database.db
          .update(jobs)
          .set({ leaseUntil: new Date(0) })
          .where(eq(jobs.id, queued.id));
        await agent();
      }

      const result = await operation;

      if (result instanceof Error) throw result;

      return contract.migrationOperation.parse(JSON.parse(result.stdout));
    };

    const listed = await migrate("list");
    expect(listed.entries).toEqual([
      { name: "2_initial.sql", applied: false },
      { name: "10_next.sql", applied: false },
    ]);
    expect((await inspect()).tables).not.toContain("d1_migrations");

    for (const [damageArtifact, message] of [
      ["missing", "503"],
      ["truncated", "Artifact download is incomplete"],
      ["oversized", "Artifact download exceeds its declared size"],
      ["modified", "Migration artifact checksum mismatch"],
    ] as const) {
      await expect(migrate("apply", { damageArtifact })).rejects.toThrow(message);
      expect((await inspect()).tables).not.toContain("items");
      expect((await inspect()).tables).not.toContain("d1_migrations");
    }

    // The heartbeat races SQL execution. Any started file may commit before the
    // failure is reported; the separate agent test deterministically holds a
    // Docker command open to verify that completion waits for it.
    const interrupted = await migrate("apply", { failHeartbeat: true }).catch((cause: unknown) =>
      z.instanceof(Error).parse(cause),
    );

    const committed = await inspect();

    const expectedItems = [
      { id: 1, note: "initial" },
      { id: 2, note: "next" },
    ];

    if (interrupted instanceof Error) {
      expect(interrupted.message).toContain("503");
    } else {
      expect(interrupted.entries?.every((entry) => entry.applied)).toBe(true);
      expect(committed.items).toEqual(expectedItems);
    }

    expect(committed.items.length).toBeLessThanOrEqual(expectedItems.length);
    expect(committed.items).toEqual(expectedItems.slice(0, committed.items.length));
    expect(committed.history.map(({ name }) => name)).toEqual(
      ["2_initial.sql", "10_next.sql"].slice(0, committed.items.length),
    );
    expect(committed.tables.includes("items")).toBe(committed.items.length > 0);
    expect(committed.tables.includes("d1_migrations")).toBe(committed.items.length > 0);

    const applied = await migrate("apply", { loseCompletion: true });
    expect(applied.entries?.every((entry) => entry.applied)).toBe(true);
    expect((await inspect()).items).toEqual([
      { id: 1, note: "initial" },
      { id: 2, note: "next" },
    ]);
    await migrate("apply");
    expect((await inspect()).history).toHaveLength(2);
    expect((await inspect(isolated.id)).items).toEqual([]);

    const first = "20261008120000_broken";
    const later = "20261008130000_later";

    for (const folder of [first, later]) {
      await mkdir(join(project, "migrations", folder));
      await writeFile(join(project, "migrations", folder, "snapshot.json"), "{}");
    }

    await writeFile(
      join(project, "migrations", first, "migration.sql"),
      "CREATE TABLE broken (id INTEGER);\n--> statement-breakpoint\nINSERT INTO items VALUES (1, 'duplicate');",
    );
    await writeFile(
      join(project, "migrations", later, "migration.sql"),
      "INSERT INTO items VALUES (3, 'later');",
    );
    await expect(migrate("apply")).rejects.toThrow(first);
    expect((await inspect()).tables).not.toContain("broken");
    expect((await inspect()).history).toHaveLength(2);
    expect((await inspect()).items).toHaveLength(2);
    expect((await migrate("list")).entries?.slice(2)).toEqual([
      { name: `${first}/migration.sql`, applied: false },
      { name: `${later}/migration.sql`, applied: false },
    ]);
    await writeFile(
      join(project, "migrations", first, "migration.sql"),
      "CREATE TABLE broken (id INTEGER);\n--> statement-breakpoint\nINSERT INTO broken VALUES (1); /* trailing comment",
    );
    await migrate("apply");
    expect((await inspect()).history.map(({ name }) => name)).toEqual([
      "2_initial.sql",
      "10_next.sql",
      `${first}/migration.sql`,
      `${later}/migration.sql`,
    ]);
    expect((await inspect()).items).toHaveLength(3);
    await writeFile(
      join(project, "wrangler.jsonc"),
      JSON.stringify({
        ...config,
        d1_databases: config.d1_databases.map((database) => ({
          ...database,
          migrations_table: "D1_MIGRATIONS",
        })),
      }),
    );
    expect((await migrate("list")).entries?.every((entry) => entry.applied)).toBe(true);

    const transaction = "20261008140000_transaction";
    await mkdir(join(project, "migrations", transaction));

    for (const statement of ["BEGIN", "COMMIT", "ROLLBACK"]) {
      await writeFile(
        join(project, "migrations", transaction, "migration.sql"),
        `INSERT INTO items VALUES (4, 'must roll back');\n${statement};\nINSERT INTO missing_table VALUES (1);`,
      );
      await expect(migrate("apply")).rejects.toThrow("not authorized");
      const remaining = await inspect();
      expect(remaining.items).toHaveLength(3);
      expect(remaining.history).toHaveLength(4);
      expect(remaining.history.map(({ name }) => name)).not.toContain(
        `${transaction}/migration.sql`,
      );
    }

    expect(
      contract.app.parse(await (await request(`/apps/${app.id}`, "GET")).json()).activeDeploymentId,
    ).toBe(deployed.id);

    const artifactPrefix = {
      Bucket: environment.configuration.S3_BUCKET,
      Prefix: `apps/${app.id}/migrations/`,
    };

    expect((await s3.send(new ListObjectsV2Command(artifactPrefix))).KeyCount).toBeGreaterThan(0);
    await request(`/apps/${app.id}`, "DELETE");
    await agent();
    expect((await s3.send(new ListObjectsV2Command(artifactPrefix))).KeyCount).toBe(0);
    expect((await inspect(isolated.id)).items).toEqual([]);
  }, 180000);
  it("confirms access through the real proxy before selecting new code", async () => {
    const app = await createApp("runtime-app-access");
    const first = await publish(app.id, "one");
    await agent();
    const edgeName = `widefleet-access-test-${crypto.randomUUID()}`;
    const authName = `${edgeName}-auth`;
    const fixturePath = join(state, "access-fixture.js");
    const routePath = join(state, "routes/access-fixture.yaml");
    const edge = { proxy: `https://${edgeName}:8443`, auth: `http://${authName}:4180/` };
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    await writeFile(
      fixturePath,
      `
      const { createServer } = require('node:http');
      createServer((request, response) => {
        const allowed = new URL(request.url, 'http://fixture').searchParams.get('allowed_groups')?.split(',') ?? [];
        const group = request.headers.cookie?.replace('fixture=', '');
        response.statusCode = !group ? 401 : allowed.length && !allowed.includes(group) ? 403 : 202;
        if (response.statusCode === 202) {
          response.setHeader('X-Auth-Request-User', 'synthetic-user');
          response.setHeader('X-Auth-Request-Groups', group);
        }
        response.end();
      }).listen(4180, '0.0.0.0');
    `,
    );
    const base = await readFile(join(root, "infra/traefik/app-auth.json"), "utf8");
    await writeFile(routePath, base.replace("http://oauth2-proxy:4180/", edge.auth));

    try {
      await execute("docker", [
        "run",
        "-d",
        "--name",
        authName,
        "--network",
        `platform-fleet-${fleetId}`,
        "--volume",
        `${fixturePath}:/fixture.js:ro`,
        "node:26.8.2-bookworm-slim",
        "node",
        "/fixture.js",
      ]);
      await execute("docker", [
        "run",
        "-d",
        "--name",
        edgeName,
        "--network",
        `platform-fleet-${fleetId}`,
        "--publish",
        "127.0.0.1::8443",
        "--volume",
        `${state}/routes:/routes:ro`,
        "traefik:v3.7.13@sha256:24841fe2de7304c149343d877d2923b4c8800a38ba015dea9174c23b20e344a0",
        "--entrypoints.websecure.address=:8443",
        "--providers.file.directory=/routes",
        "--providers.file.watch=true",
      ]);
      const published = (await execute("docker", ["port", edgeName, "8443/tcp"])).stdout.trim();
      let origin = `https://${app.hostname}:${new URL(`https://${published}`).port}`;
      browser = await chromium.launch();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const path = `/apps/${app.id}/access`;
      expect(
        JSON.parse(
          (await cli("access", "set", "--app", app.id, "--group", "finance", "--no-wait")).stdout,
        ),
      ).toMatchObject({
        state: "pending",
        groups: ["finance"],
      });
      await agent(undefined, undefined, undefined, edge);
      expect(await (await request(path, "GET")).json()).toMatchObject({
        state: "active",
        revision: 1,
        appliedRevision: 1,
      });
      expect((await context.request.get(origin, { maxRedirects: 0 })).status()).toBe(401);
      const allowed = await context.request.get(origin, { headers: { cookie: "fixture=finance" } });
      expect(allowed.status()).toBe(200);
      expect(await allowed.json()).toMatchObject({ version: "one" });
      expect(
        (
          await context.request.get(`${origin}/note.txt`, {
            headers: { cookie: "fixture=engineering" },
          })
        ).status(),
      ).toBe(403);

      const preview = await createApp("runtime-access-review", app.id, "review");
      await publish(preview.id, "preview");
      await agent(undefined, undefined, undefined, edge);
      let previewOrigin = `https://${preview.hostname}:${new URL(origin).port}`;
      expect(
        (
          await context.request.get(previewOrigin, { headers: { cookie: "fixture=finance" } })
        ).status(),
      ).toBe(200);
      expect(
        (
          await context.request.get(previewOrigin, { headers: { cookie: "fixture=engineering" } })
        ).status(),
      ).toBe(403);

      await execute("docker", ["stop", edgeName]);
      await publish(app.id, "two");
      await expect(agent(undefined, undefined, undefined, edge)).rejects.toThrow(
        /Traefik has not confirmed.*curl: \((6|7)\)/s,
      );
      expect(await appState(app.id)).toMatchObject({ version: "one" });
      expect(await (await request(`/apps/${app.id}`, "GET")).json()).toMatchObject({
        activeDeploymentId: first.id,
      });
      await execute("docker", ["start", edgeName]);
      const restarted = (await execute("docker", ["port", edgeName, "8443/tcp"])).stdout.trim();
      origin = `https://${app.hostname}:${new URL(`https://${restarted}`).port}`;
      previewOrigin = `https://${preview.hostname}:${new URL(origin).port}`;
      const second = await publish(app.id, "two");
      await agent(undefined, undefined, undefined, edge);
      expect(await appState(app.id)).toMatchObject({ version: "two" });
      expect(await (await request(`/apps/${app.id}`, "GET")).json()).toMatchObject({
        activeDeploymentId: second.id,
      });
      await cli("access", "set", "--app", app.id, "--all-authenticated", "--no-wait");
      await agent(undefined, undefined, undefined, edge);
      await agent(undefined, undefined, undefined, edge);
      expect(JSON.parse((await cli("access", "show", "--app", app.id)).stdout)).toMatchObject({
        state: "active",
        revision: 2,
        groups: [],
        previews: [{ appId: preview.id, groups: [], state: "active", revision: 2 }],
      });
      expect(
        (
          await context.request.get(`${origin}/note.txt`, {
            headers: { cookie: "fixture=engineering" },
          })
        ).status(),
      ).toBe(200);
      expect(
        (
          await context.request.get(previewOrigin, { headers: { cookie: "fixture=engineering" } })
        ).status(),
      ).toBe(200);
      expect((await context.request.get(origin, { maxRedirects: 0 })).status()).toBe(401);
      expect((await context.request.get(previewOrigin, { maxRedirects: 0 })).status()).toBe(401);
      await request(`/apps/${preview.id}`, "DELETE");
      await agent();
      await request(`/apps/${app.id}`, "DELETE");
      await agent();
    } finally {
      await browser?.close();
      await execute("docker", ["rm", "-f", edgeName, authName]);
      await rm(routePath, { force: true });
    }
  }, 180000);
  it("deploys and manages standard app Workflows through CLI, agent and runtime", async () => {
    appDirectory = join(state, "workflow app");
    await mkdir(join(appDirectory, "public"), { recursive: true });
    const app = await createApp("workflow-app");

    const source = `import { WorkflowEntrypoint } from 'cloudflare:workers';
      import { NonRetryableError } from 'cloudflare:workflows';
      export class Example extends WorkflowEntrypoint {
        async run(event, step) {
          await step.do('validate', { retries: { limit: 2, delay: 10 } }, async () => {
            if (event.payload?.reject) throw new NonRetryableError('invalid input');
          });
          await step.do('write', async () => {
            await this.env.DB.exec('CREATE TABLE IF NOT EXISTS workflow_records (id TEXT PRIMARY KEY)');
            await this.env.DB.prepare('INSERT INTO workflow_records VALUES (?)').bind(event.instanceId).run();
          });
          await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
          return step.do('read', async () => ({ id: await this.env.DB.prepare('SELECT id FROM workflow_records WHERE id = ?').bind(event.instanceId).first('id'), version: 'original' }));
        }
      }
      export default { fetch() { return new Response('workflow app'); } };`;

    const config = {
      name: app.slug,
      main: "worker.js",
      compatibility_date: "2026-10-01",
      assets: { directory: "public", binding: "ASSETS" },
      d1_databases: [{ binding: "DB", database_name: "workflow-db" }],
      workflows: [{ binding: "WORKFLOW", name: "example", class_name: "Example" }],
    };

    await writeFile(join(appDirectory, "worker.js"), source);
    await writeFile(join(appDirectory, "wrangler.jsonc"), JSON.stringify(config));
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await agent();
    expect(
      z.array(contract.deployment).parse(JSON.parse((await cli("history", app.id)).stdout))[0]
        ?.status,
    ).toBe("succeeded");
    expect(JSON.parse((await cli("workflows", "definitions")).stdout)).toEqual([
      { type: "workflow", name: "WORKFLOW", workflow_name: "example", class_name: "Example" },
    ]);

    const retainedVersions = {
      Bucket: environment.configuration.S3_BUCKET,
      Prefix: `fleets/${fleetId}/r2/widefleet-packages/workflow-versions/${app.id}/`,
    };

    expect((await s3.send(new ListObjectsV2Command(retainedVersions))).KeyCount).toBe(1);

    const operation = async (...args: string[]) => {
      const queued = contract.workflowOperation.parse(
        JSON.parse((await cli("workflows", ...args, "--no-wait")).stdout),
      );

      expect(queued.state).toBe("queued");
      await agent();

      const result = contract.workflowOperation.parse(
        JSON.parse((await cli("workflows", "operation", queued.id)).stdout),
      );

      expect(result.state, result.message ?? "Workflow job failed").toBe("succeeded");

      return result.result;
    };

    expect(await operation("create", "example", "--id", "retained-instance")).toEqual({
      id: "retained-instance",
    });
    await writeFile(join(appDirectory, "rejected.json"), '{"reject":true}');
    await operation("create", "example", "--id", "rejected-instance", "--params", "rejected.json");
    expect(await operation("status", "example", "rejected-instance")).toMatchObject({
      status: "errored",
      error: { name: "NonRetryableError", message: "invalid input" },
    });
    await operation("delete", "example", "rejected-instance");
    const browser = await chromium.launch();

    try {
      const page = await browser.newPage({
        extraHTTPHeaders: Object.fromEntries(managementHeaders),
      });

      await page.goto(`${environment.configuration.PLATFORM_URL}/apps/${app.id}`);
      await page.getByRole("link", { name: "Workflows", exact: true }).click();
      await page.getByRole("heading", { name: "Workflows", exact: true }).waitFor();
      await page.getByLabel("Action", { exact: true }).selectOption("create");
      await page.getByLabel("Parameters (JSON)").fill('{"message":"draft"}');
      await page.getByRole("link", { name: "Overview", exact: true }).click();
      await page.getByRole("link", { name: "Workflows", exact: true }).click();
      expect(await page.getByLabel("Action", { exact: true }).inputValue()).toBe("create");
      expect(await page.getByLabel("Parameters (JSON)").inputValue()).toBe('{"message":"draft"}');
      await page.getByLabel("Action", { exact: true }).selectOption("list");
      await page.getByRole("button", { name: "Run action", exact: true }).click();
      await page.getByText("Requested — waiting for the agent.", { exact: true }).waitFor();
      const pendingOperation = await page.getByText("Operation:", { exact: false }).textContent();

      await page.getByRole("link", { name: "Overview", exact: true }).click();
      await page.getByRole("link", { name: "Workflows", exact: true }).click();
      await page.getByText("Requested — waiting for the agent.", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Processing request …" }).isDisabled()).toBe(
        true,
      );
      expect(await page.getByText("Operation:", { exact: false }).textContent()).toBe(
        pendingOperation,
      );
      await agent();
      await page.getByText("Request completed.", { exact: true }).waitFor();
      expect(await page.locator("#workflows pre").textContent()).toContain("retained-instance");
    } finally {
      await browser.close();
    }

    await execute("docker", ["stop", `platform-fleet-${fleetId}`]);
    await operation("pause", "example", "retained-instance");
    expect(await operation("status", "example", "retained-instance")).toMatchObject({
      status: "paused",
    });
    await execute("docker", ["rm", "-f", `platform-fleet-${fleetId}`]);
    await operation("resume", "example", "retained-instance");
    await writeFile(
      join(appDirectory, "worker.js"),
      "export default { fetch() { return new Response('new code'); } };",
    );
    await writeFile(
      join(appDirectory, "wrangler.jsonc"),
      JSON.stringify({ ...config, workflows: [], d1_databases: [] }),
    );
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await agent();
    expect((await appRequest(app.id)).stdout).toBe("new code");
    await writeFile(join(appDirectory, "event.json"), "{}");
    await operation(
      "send-event",
      "example",
      "retained-instance",
      "continue",
      "--payload",
      "event.json",
    );
    expect(await operation("status", "example", "retained-instance")).toMatchObject({
      status: "complete",
      output: { id: "retained-instance", version: "original" },
    });
    expect(await operation("list", "example")).toMatchObject({
      instances: [expect.objectContaining({ id: "retained-instance", status: "complete" })],
    });
    await writeFile(
      join(appDirectory, "wrangler.jsonc"),
      JSON.stringify({
        ...config,
        d1_databases: [],
        workflows: [{ binding: "WORKFLOW", name: "example", class_name: "Missing" }],
      }),
    );
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await expect(agent()).rejects.toThrow("does not provide an export named 'Missing'");
    expect(
      z.array(contract.deployment).parse(JSON.parse((await cli("history", app.id)).stdout))[0]
        ?.status,
    ).toBe("failed");
    expect((await appRequest(app.id)).stdout).toBe("new code");
    expect((await s3.send(new ListObjectsV2Command(retainedVersions))).KeyCount).toBe(1);
    await cli("delete", app.id, "--yes");
    await execute("docker", ["stop", `platform-fleet-${fleetId}`]);
    await agent();
    await expect(appRequest(app.id)).rejects.toThrow();
    expect((await s3.send(new ListObjectsV2Command(retainedVersions))).KeyCount).toBe(0);
  }, 180_000);
  it("does not retain rejected Workflow versions or block runtime rollback", async () => {
    appDirectory = join(state, "rejected workflow app");
    await mkdir(join(appDirectory, "public"), { recursive: true });
    const app = await createApp("rejected-workflow-app");

    const config = {
      name: app.slug,
      main: "worker.js",
      compatibility_date: "2026-10-01",
      assets: { directory: "public", binding: "ASSETS" },
    };

    await writeFile(
      join(appDirectory, "worker.js"),
      "export default { fetch() { return new Response('plain app'); } };",
    );
    await writeFile(join(appDirectory, "wrangler.jsonc"), JSON.stringify(config));
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await agent();
    await writeFile(
      join(appDirectory, "wrangler.jsonc"),
      JSON.stringify({
        ...config,
        workflows: [{ binding: "WORKFLOW", name: "example", class_name: "Missing" }],
      }),
    );
    await cli("deploy", app.id, "--skip-build", "--no-wait");
    await expect(agent()).rejects.toThrow("does not provide an export named 'Missing'");
    expect(
      (
        await s3.send(
          new ListObjectsV2Command({
            Bucket: environment.configuration.S3_BUCKET,
            Prefix: `fleets/${fleetId}/r2/widefleet-packages/workflow-versions/${app.id}/`,
          }),
        )
      ).KeyCount,
    ).toBe(0);
    const original = await bundledRuntime();

    const previous = await wrappedRuntime(
      "0.1.97",
      `
      import runtime from './fixture-original.js';
      export * from './fixture-original.js';
      export default { ...runtime, async fetch(request, env, ctx) {
        const response = await runtime.fetch(request, env, ctx);
        if (new URL(request.url).pathname === '/.well-known/widefleet/runtime' && response.ok)
          return Response.json({ runtimeVersion: '0.1.97' });
        return response;
      } };
    `,
    );

    delete previous.workflows;
    await manageRuntime("/runtime", previous);
    await agent();
    expect(await manageRuntime("/runtime")).toMatchObject({
      activeVersion: "0.1.97",
      state: "succeeded",
    });
    expect((await appRequest(app.id)).stdout).toBe("plain app");
    await manageRuntime("/runtime", original);
    await agent();
    await cli("delete", app.id, "--yes");
    await execute("docker", ["rm", "-f", `platform-fleet-${fleetId}`]);
    await agent();
    await expect(appRequest(app.id)).rejects.toThrow();
  }, 180_000);
});
