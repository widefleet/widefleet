import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { cliPlatform } from "../../../tools/cli-platforms.ts";
import { runPnpm } from "../../../tools/cli-tools.ts";
import { startCliRegistry } from "./cli-registry.ts";

const execute = promisify(execFile);

describe.runIf(process.env["RUN_CLI_PACKAGE_TESTS"] === "1")(
  "CLI packages on the native host",
  () => {
    let platform: ReturnType<typeof cliPlatform>;
    let registry: Awaited<ReturnType<typeof startCliRegistry>>;
    let directory: string;
    let origin: string;
    let version: string;
    let environment: NodeJS.ProcessEnv;
    const appId = "00000000-0000-4000-8000-000000000001";
    const deploymentId = "00000000-0000-4000-8000-000000000002";

    const queued = {
      id: deploymentId,
      appId,
      artifactId: deploymentId,
      status: "queued",
      createdAt: "2026-10-01T00:00:00Z",
      finishedAt: null,
      message: null,
    };

    let uploads = 0;
    let historyReads = 0;

    const server = createServer((request, response) => {
      request.resume();
      const path = decodeURIComponent(request.url ?? "").slice(1);

      if (path.startsWith("api/")) {
        if (request.headers.authorization !== "Bearer synthetic-package-token") {
          response.writeHead(401).end();

          return;
        }

        response.setHeader("content-type", "application/json");

        if (request.method === "POST" && path === `api/v1/apps/${appId}/assets-upload-session`) {
          response.end(
            JSON.stringify({
              id: deploymentId,
              expiresAt: "2026-10-01T00:00:00Z",
              missing: [],
              url: "https://fixture.example.test",
            }),
          );
        } else if (request.method === "PUT" && path === `api/v1/apps/${appId}/worker`) {
          uploads += 1;
          response.end(JSON.stringify(queued));
        } else if (path === `api/v1/apps/${appId}/deployments/${deploymentId}/events`) {
          response.end("[]");
        } else if (path === `api/v1/apps/${appId}/deployments`) {
          historyReads += 1;
          response.end(JSON.stringify([queued]));
        } else {
          response.writeHead(404).end("{}");
        }

        return;
      }

      response.writeHead(404).end();
    });

    beforeAll(async () => {
      platform = cliPlatform(process.platform, process.arch);
      directory = await mkdtemp(join(tmpdir(), "widefleet package test "));
      const source = resolve(process.env["CLI_PACKAGE_DIR"] ?? ".local/releases");
      version = z
        .object({ version: z.string() })
        .parse(JSON.parse(await readFile("package.json", "utf8"))).version;
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;

      registry = await startCliRegistry(join(source, `widefleet-${version}.tgz`));

      const pnpmHome = join(directory, "pnpm home");

      const searchPath =
        Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";

      await mkdir(join(pnpmHome, "bin"), { recursive: true });
      await writeFile(join(directory, "npmrc"), "\n");
      environment = {
        ...process.env,
        PNPM_HOME: pnpmHome,
        PATH: `${join(pnpmHome, "bin")}${delimiter}${searchPath}`,
        NPM_CONFIG_USERCONFIG: join(directory, "npmrc"),
        CI: "true",
        WIDEFLEET_TELEMETRY_DISABLED: "1",
        WRANGLER_SEND_METRICS: "false",
      };

      // Avoid duplicate PATH/Path keys when passing an environment on Windows.
      for (const key of Object.keys(environment))
        if (key !== "PATH" && key.toUpperCase() === "PATH") delete environment[key];
    });

    afterAll(async () => {
      await registry?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    });

    it("installs only the matching native package without scripts and builds an independent starter", async () => {
      await runPnpm(
        [
          `--config.global-dir=${join(directory, "global packages")}`,
          "add",
          "--registry",
          registry.url,
          "--global",
          "--ignore-scripts",
          "--store-dir",
          join(directory, "store"),
          `widefleet@${version}`,
        ],
        directory,
        environment,
      );
      expect([...new Set(registry.downloads)].sort()).toEqual(
        [`widefleet-${version}.tgz`, `widefleet-${platform.name}-${version}.tgz`].sort(),
      );

      const run = (...args: string[]) =>
        runPnpm(["exec", "widefleet", ...args], directory, environment);

      expect((await run("--version")).stdout.trim()).toBe(`widefleet ${version}`);
      const project = join(directory, "app with spaces");
      await run("init", project);
      expect(await readFile(join(project, ".gitattributes"), "utf8")).toContain("eol=lf");
      expect(await readFile(join(project, ".gitignore"), "utf8")).toContain("node_modules/");
      expect(await readFile(join(project, "pnpm-lock.yaml"), "utf8")).toContain("lockfileVersion:");
      await runPnpm(["install", "--frozen-lockfile"], project, environment);
      await runPnpm(["check"], project, environment);
      await runPnpm(["build"], project, environment);
      expect(await readFile(join(project, "build/worker.js"), "utf8")).toBeTruthy();

      const deployment = await runPnpm(
        ["exec", "widefleet", "deploy", appId, "--skip-build", "--no-wait", "--json"],
        project,
        {
          ...environment,
          PLATFORM_URL: origin,
          PLATFORM_ACCESS_TOKEN: "synthetic-package-token",
        },
      );

      expect(JSON.parse(deployment.stdout)).toMatchObject({
        appId,
        status: "queued",
        url: "https://fixture.example.test",
      });
      expect(uploads).toBe(1);
    }, 180_000);

    // Node's signal API cannot emulate console Ctrl+C on Windows.
    it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
      "forwards %s through the installed launcher and reaps the native child",
      async (signal) => {
        const project = join(directory, `interruption ${signal}`);
        await mkdir(join(project, "public"), { recursive: true });
        await writeFile(join(project, "package.json"), JSON.stringify({ private: true }));
        await writeFile(join(project, "pnpm-workspace.yaml"), "packages: []\n");
        await writeFile(join(project, "worker.js"), "export default { fetch() {} };\n");
        await writeFile(
          join(project, "wrangler.jsonc"),
          JSON.stringify({
            main: "worker.js",
            compatibility_date: "2026-06-01",
            assets: { directory: "public", binding: "ASSETS" },
          }),
        );
        await runPnpm(
          [
            "add",
            "--registry",
            registry.url,
            "--ignore-scripts",
            "--store-dir",
            join(directory, "store"),
            `widefleet@${version}`,
          ],
          project,
          environment,
        );

        const initialReads = historyReads;

        const deployment = execute(
          process.execPath,
          [
            join(project, "node_modules/widefleet/bin/widefleet.mjs"),
            "deploy",
            appId,
            "--skip-build",
            "--json",
          ],
          {
            cwd: project,
            timeout: 15_000,
            env: {
              ...environment,
              PLATFORM_URL: origin,
              PLATFORM_ACCESS_TOKEN: "synthetic-package-token",
            },
          },
        );

        const interrupted = deployment.then(
          () => null,
          (cause: unknown) =>
            z.object({ code: z.number(), stdout: z.string(), stderr: z.string() }).parse(cause),
        );

        let nativePid: number | undefined;

        try {
          await vi.waitFor(() => expect(historyReads).toBeGreaterThan(initialReads), {
            timeout: 5_000,
          });

          const children = await execute("pgrep", [
            "-P",
            String(z.number().parse(deployment.child.pid)),
          ]);

          const pid = z.coerce.number().int().positive().parse(children.stdout.trim());
          nativePid = pid;
          deployment.child.kill(signal);
          const result = await interrupted;
          expect(result).toMatchObject({ code: signal === "SIGINT" ? 1 : 143, stdout: "" });
          expect(result?.stderr).toContain(`Deployment ID: ${deploymentId}`);

          if (signal === "SIGINT") expect(result?.stderr).toContain("Stopped waiting");
          expect(() => process.kill(pid, 0)).toThrow();
        } finally {
          deployment.child.kill("SIGKILL");

          if (nativePid !== undefined) {
            try {
              process.kill(nativePid, "SIGKILL");
            } catch (cause) {
              expect(z.object({ code: z.string() }).parse(cause).code).toBe("ESRCH");
            }
          }
        }
      },
      30_000,
    );

    it("explains missing optional dependencies without downloading binaries at launch", async () => {
      const source = resolve(process.env["CLI_PACKAGE_DIR"] ?? ".local/releases");
      const extracted = join(directory, "missing dependency");
      await mkdir(extracted);
      await execute("tar", ["-xzf", `widefleet-${version}.tgz`, "-C", extracted], {
        cwd: source,
      });

      const failure = await execute(
        process.execPath,
        [join(extracted, "package/bin/widefleet.mjs"), "--version"],
        { env: environment },
      ).then(
        () => null,
        (cause: unknown) => z.object({ code: z.number(), stderr: z.string() }).parse(cause),
      );

      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain(`widefleet-${platform.name} is missing`);
      expect(failure?.stderr).toContain("optional dependencies enabled");
    });
  },
);
