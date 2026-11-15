import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect } from "vitest";
import { serviceDocumentation, workerMetadata } from "@platform/contracts";
import { z } from "zod";
import { esbuildBinary } from "../../../tools/cli-tools.ts";
import { executeCli } from "./cli-process.ts";

const execute = promisify(execFile);

let installation: string;

let executable: string;

let origin: string;

let upload: { body: string; contentType: string } | undefined;

const id = "00000000-0000-4000-8000-000000000001";

const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8").on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    response.setHeader("content-type", "application/json");

    if (request.url === "/api/v1/apps/by-name/documentation") {
      response.end(
        JSON.stringify({
          id,
          slug: "documentation",
          displayName: "Documentation",
          catalogListed: false,
          parentId: null,
          organizationId: id,
          hostname: "documentation.apps.localhost",
          url: "https://documentation.apps.localhost/",
          state: "active",
          activeDeploymentId: id,
          createdAt: "2026-10-01T00:00:00Z",
        }),
      );
    } else if (request.url === `/api/v1/apps/${id}/assets-upload-session`) {
      response.end(
        JSON.stringify({
          id,
          expiresAt: "2026-10-01T00:00:00Z",
          missing: [],
          url: "https://documentation.apps.localhost/",
        }),
      );
    } else if (request.url === `/api/v1/apps/${id}/worker`) {
      upload = { body, contentType: request.headers["content-type"] ?? "" };
      response.end(
        JSON.stringify({
          id,
          appId: id,
          artifactId: id,
          status: "queued",
          createdAt: "2026-10-01T00:00:00Z",
          finishedAt: null,
          message: null,
        }),
      );
    } else response.writeHead(404).end();
  });
});

beforeAll(async () => {
  if (process.env["RUN_CLI_TESTS"] !== "1") return;
  installation = await mkdtemp(join(tmpdir(), "native-docs-cli-"));
  const extension = process.platform === "win32" ? ".exe" : "";
  executable = join(installation, `widefleet${extension}`);
  await copyFile(
    process.env["CLI_BINARY"] ??
      fileURLToPath(new URL(`../../../target/debug/widefleet${extension}`, import.meta.url)),
    executable,
  );
  await copyFile(esbuildBinary(), join(installation, `esbuild${extension}`));

  const version = (await execute(executable, ["--version"])).stdout
    .trim()
    .replace(/^widefleet /, "");

  const esbuildVersion = (await execute(esbuildBinary(), ["--version"])).stdout.trim();
  await writeFile(
    join(installation, "release.json"),
    JSON.stringify({ format: 1, version, esbuild_version: esbuildVersion }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
});

afterAll(async () => {
  if (!installation) return;

  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await rm(installation, { recursive: true, force: true });
});

export async function extractServiceDocumentation(
  project: string,
  bundle: string,
  entrypoints: string[],
) {
  upload = undefined;
  const config = join(project, "documentation.jsonc");
  await writeFile(
    config,
    JSON.stringify({ name: "documentation", main: bundle, compatibility_date: "2026-10-01" }),
  );
  const emptyPath = join(project, "no-executables");
  await mkdir(emptyPath, { recursive: true });

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );

  Object.assign(environment, {
    PATH: emptyPath,
    WIDEFLEET_NODE: join(emptyPath, "missing-node"),
    PLATFORM_URL: origin,
    PLATFORM_ACCESS_TOKEN: "synthetic-credential",
  });

  const result = await executeCli(
    executable,
    ["deploy", "--config", config, "--skip-build", "--no-wait", "--json"],
    {
      cwd: project,
      timeout: 10000,
      // The complete extraction and upload must work without Node or any executable on PATH.
      env: environment,
    },
  );

  const received = z.object({ body: z.string(), contentType: z.string() }).parse(upload);

  const form = await new Response(received.body, {
    headers: { "content-type": received.contentType },
  }).formData();

  const metadata = workerMetadata.parse(JSON.parse(z.string().parse(form.get("metadata"))));
  expect(metadata.entrypoints).toEqual(expect.arrayContaining(entrypoints));

  return {
    documentation: serviceDocumentation.parse(metadata.service_documentation),
    warnings: result.stderr
      .split("\n")
      .filter((line) => line.startsWith("Warning: "))
      .map((line) => line.slice(9)),
  };
}
