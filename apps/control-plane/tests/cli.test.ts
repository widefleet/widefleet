import { esbuildBinary } from "../../../tools/cli-tools.ts";
import * as contract from "@platform/contracts";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

const executableName = process.platform === "win32" ? "widefleet.exe" : "widefleet";

const bundlerName = process.platform === "win32" ? "esbuild.exe" : "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")(
  "CLI deployment output with a local API",
  () => {
    const app = contract.app.parse({
      id: "00000000-0000-4000-8000-000000000001",
      slug: "server-app",
      displayName: "Server App",
      catalogListed: false,
      parentId: null,
      fleetId: "00000000-0000-4000-8000-000000000002",
      hostname: "server-app.apps.localhost",
      url: "https://server-app.apps.localhost:25453/",
      createdAt: "2026-10-01T00:00:00.000Z",
      state: "created",
      activeDeploymentId: null,
    });

    const queued = contract.deployment.parse({
      id: "00000000-0000-4000-8000-000000000003",
      appId: app.id,
      artifactId: "00000000-0000-4000-8000-000000000004",
      status: "queued",
      createdAt: app.createdAt,
      finishedAt: null,
      message: null,
    });

    const finishedAt = "2026-10-01T00:00:01.000Z";

    const preview = contract.app.parse({
      ...app,
      id: "00000000-0000-4000-8000-000000000005",
      slug: "server-app-review",
      parentId: app.id,
      hostname: "review.server-app.apps.localhost",
      url: "https://review.server-app.apps.localhost:25453/",
    });

    const requests: string[] = [];
    const catalogUpdates: z.infer<typeof contract.catalogListing>[] = [];
    const createdPreviews: z.infer<typeof contract.createAppInput>[] = [];
    let storedPreview: z.infer<typeof contract.app> | null = null;
    let parent = app;
    let previewLookupStatus = 200;
    let concurrentCreation = false;
    let state: string;
    let origin: string;
    let outcome = "succeeded";
    let accessToken = "synthetic-cli-token";
    let includeUrl = true;
    let historyReads = 0;
    let logFailure: { code: string; message: string } | null = null;

    const server = createServer((request, response) => {
      request.resume();
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");

      if (request.method === "GET" && request.url === "/api/v1/catalog") {
        response.end(
          JSON.stringify([
            {
              id: app.id,
              displayName: app.displayName,
              hostname: app.hostname,
              url: app.url,
            },
          ]),
        );

        return;
      }

      if (request.method === "PUT" && request.url === `/api/v1/apps/${app.id}/catalog`) {
        let body = "";
        request.setEncoding("utf8").on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const input = contract.catalogListing.parse(JSON.parse(body));
          catalogUpdates.push(input);
          response.end(JSON.stringify(input));
        });

        return;
      }

      if (request.method === "GET" && request.url === "/api/v1/apps") {
        response.end(JSON.stringify([{ ...app, catalogListed: true }, preview]));

        return;
      }

      if (request.method === "POST" && request.url === "/api/v1/apps") {
        let body = "";
        request.setEncoding("utf8").on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const input = contract.createAppInput.parse(JSON.parse(body));
          createdPreviews.push(input);
          storedPreview = {
            ...preview,
            slug: input.slug,
            displayName: input.displayName,
            parentId: input.parentId,
            hostname: `${input.previewName}.${parent.hostname}`,
          };

          if (concurrentCreation)
            response.writeHead(409).end(JSON.stringify({ message: "App name already in use" }));
          else response.end(JSON.stringify(storedPreview));
        });

        return;
      }

      if (request.method === "GET" && request.url === "/api/v1/apps/by-name/fixture") {
        response.end(JSON.stringify(parent));

        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/api/v1/apps/by-name/server-app-")) {
        if (previewLookupStatus !== 200)
          response
            .writeHead(previewLookupStatus)
            .end(JSON.stringify({ message: "Preview access denied" }));
        else if (storedPreview) response.end(JSON.stringify(storedPreview));
        else response.writeHead(404).end(JSON.stringify({ message: "App not found" }));

        return;
      }

      if (request.url === `/api/v1/apps/${preview.id}/assets-upload-session`) {
        response.end(
          JSON.stringify({
            id: queued.artifactId,
            expiresAt: finishedAt,
            missing: [],
            url: preview.url,
          }),
        );

        return;
      }

      if (request.url === `/api/v1/apps/${preview.id}/worker`) {
        response.end(JSON.stringify({ ...queued, appId: preview.id }));

        return;
      }

      if (request.url === `/api/v1/apps/${preview.id}/deployments/${queued.id}/events`) {
        response.end(JSON.stringify([{ id: 1, message: "Synthetic preview progress" }]));

        return;
      }

      if (request.url === `/api/v1/apps/${preview.id}/deployments`) {
        historyReads += 1;
        response.end(
          JSON.stringify([
            {
              ...queued,
              appId: preview.id,
              status: outcome,
              finishedAt,
              message: outcome === "failed" ? "Synthetic preview failure" : "Activated",
            },
          ]),
        );

        return;
      }

      if (
        request.method === "GET" &&
        request.headers.authorization === "Bearer synthetic-write-only-token"
      ) {
        response.statusCode = 403;
        response.end(JSON.stringify({ message: "The access token lacks the required scope" }));

        return;
      }

      if (request.url === "/api/v1/runtime" || request.url === "/api/v1/runtime/rollback") {
        response.end(
          JSON.stringify({
            desiredVersion: "0.1.0",
            activeVersion: outcome === "succeeded" ? "0.1.0" : "0.2.0",
            jobId: queued.id,
            state: request.method === "POST" ? "queued" : outcome,
            message: outcome === "failed" ? "Runtime readiness failed" : "Activated",
            versions: ["0.1.0", "0.2.0"],
          }),
        );

        return;
      }

      if (request.url === "/api/v1/settings/plan") {
        response.end(
          JSON.stringify({ restartRequired: true, message: "App sign-in will restart." }),
        );

        return;
      }

      if (
        request.url === "/api/v1/settings" ||
        request.url === "/api/v1/settings/external-management"
      ) {
        response.end(
          JSON.stringify({
            settings: { identity: null, externallyManaged: false },
            activation: { state: "active" },
          }),
        );

        return;
      }

      if (request.url?.startsWith("/api/v1/groups?")) {
        const query = new URL(request.url, "http://fixture.test").searchParams;

        if (query.get("query") !== "Einkauf" || query.get("limit") !== "2") {
          response.writeHead(400).end();

          return;
        }

        response.end(
          JSON.stringify({
            groups: [
              { id: "native-group-id", name: "Einkauf", description: null, source: "Company" },
            ],
            hasMore: true,
          }),
        );

        return;
      }

      if (logFailure && request.url?.startsWith(`/api/v1/apps/${app.id}/logs?`)) {
        response.writeHead(503).end(JSON.stringify(logFailure));

        return;
      }

      if (
        (request.method === "PUT" && request.url === "/api/v1/apps/by-name/fixture") ||
        (request.method === "GET" && request.url === `/api/v1/apps/${app.id}`)
      ) {
        response.end(
          JSON.stringify(
            includeUrl ? parent : contract.app.omit({ url: true }).strip().parse(parent),
          ),
        );
      } else if (request.url === `/api/v1/apps/${app.id}/assets-upload-session`) {
        const session = { id: queued.artifactId, expiresAt: finishedAt, missing: [] };
        response.end(JSON.stringify(includeUrl ? { ...session, url: app.url } : session));
      } else if (request.url === `/api/v1/apps/${app.id}/worker`) {
        response.end(JSON.stringify(queued));
      } else if (request.url === `/api/v1/apps/${app.id}/deployments/${queued.id}/events`) {
        response.end(JSON.stringify([{ id: 1, message: "Synthetic deployment progress" }]));
      } else if (request.url === `/api/v1/apps/${app.id}/deployments`) {
        historyReads += 1;
        response.end(
          JSON.stringify([
            {
              ...queued,
              status: historyReads === 1 ? "running" : outcome,
              finishedAt: historyReads === 1 ? null : finishedAt,
              message: outcome === "failed" ? "Synthetic activation failure" : "Activated",
            },
          ]),
        );
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Unexpected fixture request" }));
      }
    });

    beforeAll(async () => {
      state = await mkdtemp(join(tmpdir(), "widefleet-cli-test-"));
      const installation = join(state, "installation");
      const project = join(state, "project with spaces");
      await mkdir(installation);
      await mkdir(join(project, "public"), { recursive: true });
      await copyFile(
        process.env["CLI_BINARY"] ?? join(root, "target/debug", executableName),
        join(installation, executableName),
      );
      const esbuild = esbuildBinary();
      await copyFile(esbuild, join(installation, bundlerName));

      const version = (await execute(join(installation, executableName), ["--version"])).stdout
        .trim()
        .replace(/^widefleet /, "");

      const esbuildVersion = (await execute(esbuild, ["--version"])).stdout.trim();
      await writeFile(
        join(installation, "release.json"),
        JSON.stringify({ format: 1, version, esbuild_version: esbuildVersion }),
      );
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ scripts: { build: "node build.mjs" } }),
      );
      await writeFile(join(project, "build.mjs"), 'console.log("Synthetic build output");\n');
      await writeFile(
        join(project, "worker.js"),
        'export default { fetch() { return new Response("fixture"); } };\n',
      );
      await writeFile(
        join(project, "wrangler.jsonc"),
        JSON.stringify({
          name: "fixture",
          main: "worker.js",
          compatibility_date: "2026-10-01",
          assets: { directory: "public", binding: "ASSETS" },
        }),
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = z.object({ port: z.number() }).parse(server.address());
      origin = `http://127.0.0.1:${address.port}`;
    });

    beforeEach(() => {
      requests.length = 0;
      catalogUpdates.length = 0;
      outcome = "succeeded";
      accessToken = "synthetic-cli-token";
      includeUrl = true;
      historyReads = 0;
      logFailure = null;
      createdPreviews.length = 0;
      storedPreview = null;
      parent = app;
      previewLookupStatus = 200;
      concurrentCreation = false;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await rm(state, { recursive: true, force: true });
    });

    const cli = (...args: string[]) =>
      execute(join(state, "installation", executableName), ["deploy", ...args], {
        cwd: join(state, "project with spaces"),
        timeout: 15_000,
        env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: accessToken },
      });

    const previewCli = (...args: string[]) =>
      execute(join(state, "installation", executableName), ["preview", ...args], {
        cwd: join(state, "project with spaces"),
        timeout: 15_000,
        env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: accessToken },
      });

    it.each([
      [
        "TELEMETRY_NOT_CONFIGURED",
        "Runtime logging is not enabled for this installation. An administrator must enable telemetry.",
      ],
      [
        "TELEMETRY_UNAVAILABLE",
        "Runtime logs are temporarily unavailable. Please try again later.",
      ],
    ])("displays %s and stops log queries, including follow mode", async (code, message) => {
      logFailure = { code, message };

      for (const args of [[], ["--follow"]]) {
        requests.length = 0;
        await expect(
          execute(
            join(state, "installation", executableName),
            ["logs", app.id, "--json", ...args],
            {
              timeout: 5000,
              env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: accessToken },
            },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stdout: "",
          stderr: `API returned 503: ${message}\n`,
        });
        expect(requests).toEqual([`GET /api/v1/apps/${app.id}/logs?since=1h&limit=100`]);
      }
    });

    it("lists, publishes and withdraws catalog entries through the API", async () => {
      const options = {
        env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: accessToken },
      };

      const binary = join(state, "installation", executableName);
      const listing = await execute(binary, ["catalog", "list"], options);
      expect(z.array(contract.catalogEntry).parse(JSON.parse(listing.stdout))).toEqual([
        {
          id: app.id,
          displayName: app.displayName,
          hostname: app.hostname,
          url: app.url,
        },
      ]);

      for (const [command, listed] of [
        ["publish", true],
        ["unpublish", false],
      ] as const) {
        const result = await execute(binary, ["catalog", command, app.id], options);
        expect(contract.catalogListing.parse(JSON.parse(result.stdout))).toEqual({ listed });
      }

      expect(catalogUpdates).toEqual([{ listed: true }, { listed: false }]);
      expect(requests).toEqual([
        "GET /api/v1/catalog",
        `PUT /api/v1/apps/${app.id}/catalog`,
        `PUT /api/v1/apps/${app.id}/catalog`,
      ]);
    });

    it("preserves catalog listing in app list JSON", async () => {
      const result = await execute(join(state, "installation", executableName), ["apps"], {
        env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: accessToken },
      });

      expect(z.array(contract.app).parse(JSON.parse(result.stdout))).toEqual([
        { ...app, catalogListed: true },
        preview,
      ]);
    });

    it("returns provider-independent group discovery as JSON", async () => {
      const result = await execute(
        join(state, "installation", executableName),
        ["groups", "search", "Einkauf", "--limit", "2", "--json"],
        {
          env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: accessToken },
        },
      );

      expect(JSON.parse(result.stdout)).toEqual({
        groups: [{ id: "native-group-id", name: "Einkauf", description: null, source: "Company" }],
        hasMore: true,
      });
      expect(result.stderr).toBe("");
    });

    const failure = async (operation: ReturnType<typeof cli>) => {
      try {
        await operation;
      } catch (error) {
        return z.object({ code: z.number(), stdout: z.string(), stderr: z.string() }).parse(error);
      }

      throw new Error("Expected the CLI to fail");
    };

    it.each(["release.json", bundlerName])(
      "rejects an installation missing %s before building or contacting the API",
      async (missing) => {
        const installation = join(state, `missing-${missing}`);
        await mkdir(installation);

        for (const file of [executableName, "release.json", bundlerName])
          if (file !== missing)
            await copyFile(join(state, "installation", file), join(installation, file));

        const result = await failure(
          execute(join(installation, executableName), ["deploy"], {
            cwd: join(state, "project with spaces"),
            env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: accessToken },
          }),
        );

        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("complete release archive");
        expect(result.stderr).not.toContain("Synthetic build output");
        expect(requests).toEqual([]);
      },
    );

    it("rejects a mismatched bundler before building or contacting the API", async () => {
      const installation = join(state, "mismatched-bundler");
      await mkdir(installation);

      for (const file of [executableName, bundlerName])
        await copyFile(join(state, "installation", file), join(installation, file));

      const version = (await execute(join(installation, executableName), ["--version"])).stdout
        .trim()
        .replace(/^widefleet /, "");

      await writeFile(
        join(installation, "release.json"),
        JSON.stringify({ format: 1, version, esbuild_version: "0.0.0" }),
      );

      const result = await failure(
        execute(join(installation, executableName), ["deploy"], {
          cwd: join(state, "project with spaces"),
          env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: accessToken },
        }),
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("installed esbuild version does not match");
      expect(result.stderr).not.toContain("Synthetic build output");
      expect(requests).toEqual([]);
    });

    it("creates an isolated named preview, waits for activation and reuses it on the next deployment", async () => {
      const first = await previewCli("--name", "review");
      expect(first.stdout).toBe(`Deployment succeeded\n${preview.url}\n`);
      expect(first.stderr).toContain("Synthetic build output");
      expect(first.stderr).toContain("Synthetic preview progress");
      expect(createdPreviews).toEqual([
        {
          slug: preview.slug,
          displayName: "server-app (review)",
          parentId: app.id,
          previewName: "review",
        },
      ]);

      const second = await previewCli("--name", "review", "--json", "--skip-build");
      expect(JSON.parse(second.stdout)).toMatchObject({
        appId: preview.id,
        status: "succeeded",
        url: preview.url,
      });
      expect(createdPreviews).toHaveLength(1);
      expect(
        requests.filter((request) => request === `PUT /api/v1/apps/${preview.id}/worker`),
      ).toHaveLength(2);
      expect(requests).not.toContain(`PUT /api/v1/apps/${app.id}/worker`);
      expect(requests.some((request) => request.startsWith("PUT /api/v1/apps/by-name/"))).toBe(
        false,
      );
    });

    it.skipIf(process.platform === "win32")(
      "deploys a preview using the selected session file",
      async () => {
        const sessionFile = join(state, "preview-session.json");
        await writeFile(
          sessionFile,
          JSON.stringify({
            origin,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            tokens: {
              access_token: accessToken,
              refresh_token: "synthetic-refresh-token",
              expires_in: 3600,
              token_type: "Bearer",
            },
          }),
          { mode: 0o600 },
        );

        const result = await execute(
          join(state, "installation", executableName),
          ["preview", "--name", "review", "--skip-build", "--session-file", sessionFile],
          {
            cwd: join(state, "project with spaces"),
            timeout: 15_000,
            env: {
              ...process.env,
              PLATFORM_URL: origin,
              PLATFORM_ACCESS_TOKEN: undefined,
              DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(state, "missing-bus")}`,
            },
          },
        );

        expect(result.stdout).toBe(`Deployment succeeded\n${preview.url}\n`);
        expect(createdPreviews).toHaveLength(1);
        expect(requests).toContain(`PUT /api/v1/apps/${preview.id}/worker`);
        expect(historyReads).toBe(1);
      },
    );

    it("accepts an explicit parent ID and custom config and returns the queued preview as JSON", async () => {
      const configuration = join(state, "project with spaces/preview.jsonc");
      await copyFile(join(state, "project with spaces/wrangler.jsonc"), configuration);

      const result = await previewCli(
        "--app",
        app.id,
        "--name",
        "review",
        "--config",
        configuration,
        "--skip-build",
        "--no-wait",
        "--json",
      );

      expect(JSON.parse(result.stdout)).toMatchObject({
        appId: preview.id,
        status: "queued",
        url: preview.url,
      });
      expect(result.stderr).not.toContain("Synthetic build output");
      expect(requests).not.toContain("GET /api/v1/apps/by-name/fixture");
      expect(historyReads).toBe(0);
    });

    it("uses the Git branch from the configured project for a stable preview name", async () => {
      const project = join(state, "project with spaces");
      await execute("git", ["init", "--initial-branch=feature/login", project]);

      try {
        await previewCli("--skip-build", "--no-wait");
        expect(createdPreviews[0]?.slug).toMatch(/^server-app-feature-login-[a-f0-9]{8}$/);
        await previewCli("--skip-build", "--no-wait");
        expect(createdPreviews).toHaveLength(1);
      } finally {
        await rm(join(project, ".git"), { recursive: true, force: true });
      }
    });

    it("requires an explicit name outside Git before making requests", async () => {
      const result = await failure(previewCli());
      expect(result.stderr).toContain("Choose --name NAME");
      expect(requests).toEqual([]);
    });

    it.each(["Review", "feature/login", "-review", "review-", "a".repeat(49)])(
      "rejects invalid preview name %s before making requests",
      async (name) => {
        const result = await failure(previewCli(`--name=${name}`));
        expect(result.stderr).toContain("Use a preview name");
        expect(requests).toEqual([]);
      },
    );

    it.each([null, "00000000-0000-4000-8000-000000000099"])(
      "refuses a name owned by an app with parent %s",
      async (parentId) => {
        storedPreview = { ...preview, parentId };
        const result = await failure(previewCli("--name", "review", "--skip-build"));
        expect(result.stderr).toContain("belongs to a different app");
        expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
      },
    );

    it("handles a concurrent creation by verifying and reusing the preview", async () => {
      concurrentCreation = true;
      const result = await previewCli("--name", "review", "--no-wait", "--skip-build", "--json");
      expect(JSON.parse(result.stdout)).toMatchObject({ appId: preview.id });
      expect(
        requests.filter((request) => request === `GET /api/v1/apps/by-name/${preview.slug}`),
      ).toHaveLength(2);
    });

    it("does not treat access failures as a missing preview", async () => {
      previewLookupStatus = 403;
      const result = await failure(previewCli("--name", "review", "--skip-build"));
      expect(result.stderr).toContain("Preview access denied");
      expect(createdPreviews).toEqual([]);
      expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    });

    it("refuses a legacy flat preview instead of publishing at the wrong hostname", async () => {
      storedPreview = { ...preview, hostname: "server-app-review.apps.localhost" };
      const result = await failure(previewCli("--name", "review", "--skip-build"));
      expect(result.stderr).toContain("does not use review.server-app.apps.localhost");
      expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    });

    it("refuses a deleting parent or preview and a preview as parent", async () => {
      parent = { ...app, state: "deleting" };
      expect((await failure(previewCli("--name", "review"))).stderr).toContain(
        "parent app is being deleted",
      );
      parent = { ...app, parentId: preview.id };
      expect((await failure(previewCli("--name", "review"))).stderr).toContain(
        "Choose the original app",
      );
      parent = app;
      storedPreview = { ...preview, state: "deleting" };
      expect((await failure(previewCli("--name", "review", "--skip-build"))).stderr).toContain(
        "preview is being deleted",
      );
      expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    });

    it("does not create a preview when the local build fails", async () => {
      const build = join(state, "project with spaces/build.mjs");
      await writeFile(build, 'console.log("Synthetic build failure"); process.exit(1);\n');

      try {
        const result = await failure(previewCli("--name", "review", "--json"));
        expect(result).toMatchObject({ code: 1, stdout: "" });
        expect(result.stderr).toContain("Synthetic build failure");
        expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
        expect(createdPreviews).toEqual([]);
      } finally {
        await writeFile(build, 'console.log("Synthetic build output");\n');
      }
    });

    it("reports preview activation failure without a success result", async () => {
      outcome = "failed";
      const result = await failure(previewCli("--name", "review", "--json", "--skip-build"));
      expect(result).toMatchObject({ code: 1, stdout: "" });
      expect(result.stderr).toContain("Synthetic preview failure");
    });

    it("uses the ordinary credential for runtime status and rollback and reports activation failure", async () => {
      const runtimeCli = (...args: string[]) =>
        execute(join(state, "installation", executableName), ["runtime", ...args], {
          env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: accessToken },
        });

      expect(JSON.parse((await runtimeCli("status")).stdout)).toMatchObject({
        activeVersion: "0.1.0",
      });
      expect(JSON.parse((await runtimeCli("rollback", "0.1.0")).stdout)).toMatchObject({
        state: "succeeded",
      });
      expect(requests).toContain("POST /api/v1/runtime/rollback");
      outcome = "failed";
      expect((await failure(runtimeCli("rollback", "0.1.0"))).stderr).toContain(
        "Runtime readiness failed",
      );
    }, 15_000);

    it("exports settings and requires explicit acknowledgement of the server's restart plan", async () => {
      const settingsFile = join(state, "settings.json");
      await writeFile(settingsFile, JSON.stringify({ identity: null, externallyManaged: false }));

      const settingsCli = (...args: string[]) =>
        execute(join(state, "installation", executableName), ["settings", ...args], {
          env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: accessToken },
        });

      expect(JSON.parse((await settingsCli("export")).stdout)).toEqual({
        identity: null,
        externallyManaged: false,
      });
      const planned = await settingsCli("plan", "--file", settingsFile);
      expect(JSON.parse(planned.stdout)).toMatchObject({ restartRequired: true });
      const blocked = await failure(settingsCli("apply", "--file", settingsFile));
      expect(blocked.stderr).toContain("--acknowledge-restart");
      expect(requests).not.toContain("PUT /api/v1/settings");
      await settingsCli("apply", "--file", settingsFile, "--acknowledge-restart");
      expect(requests).toContain("PUT /api/v1/settings");
      await settingsCli("external-management", "true");
      expect(requests).toContain("PUT /api/v1/settings/external-management");
    });

    it("prints the server's URL after successful activation and keeps build logs on stderr", async () => {
      const result = await cli();
      expect(result.stdout).toBe(`Deployment succeeded\n${app.url}\n`);
      expect(result.stderr).toContain("Synthetic build output");
      expect(result.stderr).toContain("Synthetic deployment progress");
      expect(result.stderr).toContain(`Deployment ID: ${queued.id}`);
      expect(historyReads).toBe(2);
    });

    it("prints one JSON result with the final status and timestamps", async () => {
      const result = await cli("--json");
      expect(contract.deployment.extend({ url: z.url() }).parse(JSON.parse(result.stdout))).toEqual(
        {
          ...queued,
          status: "succeeded",
          finishedAt,
          message: "Activated",
          url: app.url,
        },
      );
      expect(result.stderr).toContain("Synthetic build output");
      expect(result.stderr).toContain("Synthetic deployment progress");
    });

    it("deploys to an explicit app with a write-only token and returns its URL without waiting", async () => {
      accessToken = "synthetic-write-only-token";
      const result = await cli(app.id, "--json", "--no-wait", "--skip-build");
      expect(contract.deployment.extend({ url: z.url() }).parse(JSON.parse(result.stdout))).toEqual(
        {
          ...queued,
          url: app.url,
        },
      );
      expect(requests).toEqual([
        `POST /api/v1/apps/${app.id}/assets-upload-session`,
        `PUT /api/v1/apps/${app.id}/worker`,
      ]);
      expect(historyReads).toBe(0);
      expect(requests.some((request) => request.includes("/events"))).toBe(false);
    });

    it("does not claim activation when waiting is disabled", async () => {
      const result = await cli("--no-wait", "--skip-build");
      expect(result.stdout).toBe("Deployment queued\n");
      expect(historyReads).toBe(0);
    });

    it("leaves stdout empty if the local build fails", async () => {
      const build = join(state, "project with spaces/build.mjs");
      await writeFile(build, 'console.log("Synthetic build failure"); process.exit(1);\n');

      try {
        const result = await failure(cli("--json"));
        expect(result).toMatchObject({ code: 1, stdout: "" });
        expect(result.stderr).toContain("Synthetic build failure");
        expect(requests).toEqual([]);
      } finally {
        await writeFile(build, 'console.log("Synthetic build output");\n');
      }
    });

    // Node kills Windows processes instead of delivering console Ctrl+C.
    it.skipIf(process.platform === "win32")(
      "does not emit a result when waiting is interrupted",
      async () => {
        const deployment = cli("--json", "--skip-build");
        const interrupted = failure(deployment);

        try {
          await vi.waitFor(() => expect(historyReads).toBe(1));
          deployment.child.kill("SIGINT");
          const result = await interrupted;
          expect(result).toMatchObject({ code: 1, stdout: "" });
          expect(result.stderr).toContain("Stopped waiting");
        } finally {
          deployment.child.kill("SIGKILL");
        }
      },
    );

    it.each([{ args: [] }, { args: ["--json"] }])(
      "exits unsuccessfully without a result on activation failure %j",
      async ({ args }) => {
        outcome = "failed";
        const result = await failure(cli(...args, "--skip-build"));
        expect(result).toMatchObject({ code: 1, stdout: "" });
        expect(result.stderr).toContain("Synthetic activation failure");
      },
    );

    it("requires a server-provided URL before uploading to an older server", async () => {
      includeUrl = false;
      const result = await failure(cli("--json", "--skip-build"));
      expect(result).toMatchObject({ code: 1, stdout: "" });
      expect(result.stderr).toContain("Upgrade the server");
      expect(requests).toEqual([
        "PUT /api/v1/apps/by-name/fixture",
        `POST /api/v1/apps/${app.id}/assets-upload-session`,
      ]);
    });
  },
);
