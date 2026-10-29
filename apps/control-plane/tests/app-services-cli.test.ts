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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")("App services CLI", () => {
  const app = contract.app.parse({
    id: "00000000-0000-4000-8000-000000000001",
    slug: "inventory",
    displayName: "Inventory",
    catalogListed: false,
    parentId: null,
    organizationId: "00000000-0000-4000-8000-000000000002",
    hostname: "inventory.apps.localhost",
    url: "https://inventory.apps.localhost/",
    state: "active",
    activeDeploymentId: "00000000-0000-4000-8000-000000000003",
    createdAt: "2026-10-01T00:00:00.000Z",
  });

  const requests: {
    path: string;
    method: string;
    authorization: string;
    contentType: string;
    requestId: string;
    body: string;
  }[] = [];

  let directory: string;
  let origin: string;
  let executable: string;
  let outcome = "active";
  let rejected = false;
  let superseded = false;
  let secretDeployment: z.infer<typeof contract.deployment> | null = null;
  let secretHistory: z.infer<typeof contract.deployment>[] = [];

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        path: request.url ?? "",
        method: request.method ?? "",
        authorization: request.headers.authorization ?? "",
        contentType: request.headers["content-type"] ?? "",
        requestId: String(request.headers["idempotency-key"] ?? ""),
        body,
      });
      response.setHeader("content-type", "application/json");

      if (request.url === "/api/v1/apps/by-name/inventory") response.end(JSON.stringify(app));
      else if (request.url === "/api/v1/app-services") {
        response.end(
          JSON.stringify([
            {
              appId: "00000000-0000-4000-8000-000000000099",
              slug: "erp-app",
              displayName: "ERP",
              entrypoints: ["Reader"],
            },
          ]),
        );
      } else if (request.url === `/api/v1/apps/${app.id}/assets-upload-session`) {
        response.end(
          JSON.stringify({
            id: "00000000-0000-4000-8000-000000000004",
            expiresAt: "2026-10-01T00:00:00Z",
            missing: [],
            url: app.url,
          }),
        );
      } else if (request.url === `/api/v1/apps/${app.id}/worker`) {
        response.end(
          JSON.stringify({
            id: app.activeDeploymentId,
            appId: app.id,
            artifactId: "00000000-0000-4000-8000-000000000004",
            status: "queued",
            createdAt: app.createdAt,
            finishedAt: null,
            message: null,
          }),
        );
      } else if (request.url?.startsWith(`/api/v1/apps/${app.id}/secrets`)) {
        const newer = request.method === "GET" ? secretHistory[0] : undefined;
        response.end(
          JSON.stringify({
            names: ["TOKEN"],
            revision: newer ? 2 : 1,
            appliedRevision: null,
            deployment: newer ?? secretDeployment,
          }),
        );
      } else if (request.url === `/api/v1/apps/${app.id}/deployments`) {
        response.end(JSON.stringify(secretHistory));
      } else if (
        request.url === `/api/v1/apps/${app.id}/deployments/${secretDeployment?.id}/events`
      ) {
        response.end("[]");
      } else if (request.url === `/api/v1/apps/${app.id}/connections`) {
        response.end(
          JSON.stringify({
            deploymentId: app.activeDeploymentId,
            resources: [
              { binding: "DB", type: "d1", target: "inventory", databaseId: "inventory-v2" },
              { binding: "FILES", type: "r2_bucket", target: "uploads" },
            ],
            connections: {
              grants: {},
              revision: 2,
              appliedRevision: 1,
              state: "failed",
              error: "Synthetic activation failure",
            },
            activeConnections: {
              ERP: { app: "00000000-0000-4000-8000-000000000099", entrypoint: "default" },
            },
          }),
        );
      } else if (request.url?.startsWith(`/api/v1/apps/${app.id}/bindings`)) {
        if (rejected && request.method !== "GET")
          response
            .writeHead(403)
            .end(JSON.stringify({ message: "Administrator permission is required" }));
        else
          response.end(
            JSON.stringify({
              grants: {
                ERP: { app: "00000000-0000-4000-8000-000000000099", entrypoint: "default" },
              },
              revision: superseded && request.method === "GET" ? 3 : 2,
              appliedRevision: request.method === "GET" && outcome === "active" ? 2 : 1,
              state: request.method === "GET" ? outcome : "pending",
              error: outcome === "failed" ? "Synthetic activation failure" : null,
            }),
          );
      } else response.writeHead(404).end();
    });
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "widefleet-app-cli-"));
    const installation = join(directory, "installation");
    await mkdir(installation);
    executable = join(installation, process.platform === "win32" ? "widefleet.exe" : "widefleet");
    await copyFile(
      process.env["CLI_BINARY"] ??
        fileURLToPath(
          new URL(
            `../../../target/debug/widefleet${process.platform === "win32" ? ".exe" : ""}`,
            import.meta.url,
          ),
        ),
      executable,
    );
    await copyFile(
      esbuildBinary(),
      join(installation, process.platform === "win32" ? "esbuild.exe" : "esbuild"),
    );

    const version = (await execute(executable, ["--version"])).stdout
      .trim()
      .replace(/^widefleet /, "");

    const esbuildVersion = (await execute(esbuildBinary(), ["--version"])).stdout.trim();
    await writeFile(
      join(installation, "release.json"),
      JSON.stringify({ format: 1, version, esbuild_version: esbuildVersion }),
    );
    await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify({ name: app.slug }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
  });
  beforeEach(() => {
    requests.length = 0;
    outcome = "active";
    rejected = false;
    superseded = false;
    secretDeployment = null;
    secretHistory = [];
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });

  const command = (...args: string[]) =>
    execute(executable, args, {
      cwd: directory,
      timeout: 10000,
      env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: "normal-credential" },
    });

  it("deploys an app API without assets or a build script and manages app connections and secrets", async () => {
    const source = `import {WorkerEntrypoint} from 'cloudflare:workers'; export class Reader extends WorkerEntrypoint { read() { return 'value'; } }`;
    await writeFile(join(directory, "service.ts"), source);
    await writeFile(
      join(directory, "service.jsonc"),
      JSON.stringify({
        name: app.slug,
        main: "service.ts",
        compatibility_date: "2026-10-01",
        widefleet: { web: false, entrypoints: ["Reader"] },
      }),
    );
    const result = await command("deploy", "--config", "service.jsonc", "--no-wait", "--json");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "queued", url: null });
    const upload = requests.find((entry) => entry.path.endsWith("/worker"));
    expect(upload).toBeDefined();

    const form = await new Response(upload?.body, {
      headers: { "content-type": upload?.contentType ?? "" },
    }).formData();

    expect(JSON.parse(z.string().parse(form.get("metadata")))).toMatchObject({
      web: false,
      entrypoints: ["Reader"],
      assets: { binding: "ASSETS" },
    });
    await writeFile(join(directory, "service.ts"), `type SourceMapOnly = string;\n${source}`);
    await command("deploy", "--config", "service.jsonc", "--no-wait", "--json");
    const rebuilt = requests.findLast((entry) => entry.path.endsWith("/worker"));

    const next = await new Response(rebuilt?.body, {
      headers: { "content-type": rebuilt?.contentType ?? "" },
    }).formData();

    const before = contract.workerMetadata.parse(
      JSON.parse(z.string().parse(form.get("metadata"))),
    );

    const after = contract.workerMetadata.parse(JSON.parse(z.string().parse(next.get("metadata"))));
    const code = form.get("worker.js");
    const nextCode = next.get("worker.js");

    if (!(code instanceof File) || !(nextCode instanceof File))
      throw new Error("Missing worker module");
    expect(await nextCode.text()).toBe(await code.text());
    expect(after.debug?.source_maps).not.toEqual(before.debug?.source_maps);
    expect(after.debug?.build_id).not.toBe(before.debug?.build_id);
    expect(requests.some((entry) => entry.path.includes("/connectors"))).toBe(false);
    expect(JSON.parse((await command("services")).stdout)).toMatchObject([
      { slug: "erp-app", entrypoints: ["Reader"] },
    ]);
    await command("connect", "erp-app", "--as", "ERP", "--entrypoint", "Reader", "--no-wait");
    expect(requests.at(-1)).toMatchObject({
      method: "PUT",
      path: `/api/v1/apps/${app.id}/bindings/ERP`,
    });
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({
      app: "00000000-0000-4000-8000-000000000099",
      entrypoint: "Reader",
    });
    await command("disconnect", "ERP", "--no-wait");
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/api/v1/apps/${app.id}/bindings/ERP`,
    });
    const secretFile = join(directory, "synthetic-secret");
    await writeFile(secretFile, "synthetic-app-secret");
    const secret = await command("secret", "put", "TOKEN", "--file", secretFile, "--json");
    expect(requests.at(-1)).toMatchObject({
      method: "PUT",
      path: `/api/v1/apps/${app.id}/secrets/TOKEN`,
      body: JSON.stringify({ value: "synthetic-app-secret" }),
    });
    expect(secret.stdout).not.toContain("synthetic-app-secret");
    await command("secret", "delete", "TOKEN");
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/api/v1/apps/${app.id}/secrets/TOKEN`,
    });
  });
  it("removes the connector command", async () => {
    await expect(command("connector", "--help")).rejects.toThrow("unrecognized subcommand");
    expect(requests).toHaveLength(0);
  });

  it.each(["queued", "running", "failed"])(
    "lists secrets without waiting for a %s deployment",
    async (status) => {
      secretDeployment = contract.deployment.parse({
        id: app.activeDeploymentId,
        appId: app.id,
        artifactId: crypto.randomUUID(),
        status,
        createdAt: app.createdAt,
        finishedAt: null,
        message: "Synthetic failure",
      });
      expect(JSON.parse((await command("secret", "list", "--json")).stdout)).toMatchObject({
        deployment: { status },
      });
      expect(requests.map((entry) => entry.path)).toEqual([
        "/api/v1/apps/by-name/inventory",
        `/api/v1/apps/${app.id}/secrets`,
      ]);
    },
  );

  it.each([
    { action: "put", status: "succeeded" },
    { action: "delete", status: "succeeded" },
    { action: "put", status: "failed" },
    { action: "delete", status: "failed" },
  ])(
    "reports its own $action deployment outcome ($status) after a newer secret edit fails",
    async ({ action, status }) => {
      secretDeployment = contract.deployment.parse({
        id: app.activeDeploymentId,
        appId: app.id,
        artifactId: crypto.randomUUID(),
        status: "queued",
        createdAt: app.createdAt,
        finishedAt: null,
        message: null,
      });

      const newer = {
        ...secretDeployment,
        id: crypto.randomUUID(),
        status: "failed" as const,
        finishedAt: app.createdAt,
        message: "Another edit failed",
      };

      secretHistory = [
        newer,
        contract.deployment.parse({
          ...secretDeployment,
          status,
          finishedAt: app.createdAt,
          message: status === "failed" ? "Own activation failed" : null,
        }),
      ];
      const secretFile = join(directory, "concurrent-secret");
      await writeFile(secretFile, "synthetic-value");
      const args = action === "put" ? ["--file", secretFile] : [];
      const result = command("secret", action, "TOKEN", ...args, "--json");

      if (status === "failed") await expect(result).rejects.toThrow("Own activation failed");
      else
        expect(JSON.parse((await result).stdout)).toMatchObject({
          revision: 2,
          deployment: { id: newer.id, status: "failed" },
        });
      expect(requests.filter((entry) => entry.path.endsWith("/events"))).toMatchObject([
        { path: `/api/v1/apps/${app.id}/deployments/${secretDeployment.id}/events` },
      ]);
      expect(
        requests.filter((entry) => entry.path === `/api/v1/apps/${app.id}/secrets`),
      ).toHaveLength(status === "succeeded" ? 1 : 0);
    },
  );

  it.each([false, true])(
    "fails secret changes when activation already failed (no-wait %s)",
    async (noWait) => {
      const options = noWait ? ["--no-wait"] : [];
      secretDeployment = contract.deployment.parse({
        id: app.activeDeploymentId,
        appId: app.id,
        artifactId: crypto.randomUUID(),
        status: "failed",
        createdAt: app.createdAt,
        finishedAt: app.createdAt,
        message: "Synthetic activation failure",
      });
      await expect(command("secret", "delete", "TOKEN", ...options)).rejects.toThrow(
        "Synthetic activation failure",
      );
      const secretFile = join(directory, "failed-secret");
      await writeFile(secretFile, "synthetic-value");
      await expect(
        command("secret", "put", "TOKEN", "--file", secretFile, ...options),
      ).rejects.toThrow("Synthetic activation failure");
    },
  );
});
