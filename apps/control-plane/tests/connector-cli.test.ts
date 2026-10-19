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

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")(
  "Connector CLI app selection and activation",
  () => {
    const app = contract.app.parse({
      id: "00000000-0000-4000-8000-000000000001",
      slug: "inventory",
      displayName: "Inventory",
      catalogListed: false,
      parentId: null,
      fleetId: "00000000-0000-4000-8000-000000000002",
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
    let uploadFailures = 0;

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
        else if (request.url === "/api/v1/connector-catalog") {
          response.end(
            JSON.stringify([
              { name: "erp", entrypoints: ["default"] },
              { name: "pending", entrypoints: [] },
            ]),
          );
        } else if (request.url === `/api/v1/apps/${app.id}/connections`) {
          response.end(
            JSON.stringify({
              deploymentId: app.activeDeploymentId,
              resources: [
                { binding: "DB", type: "d1", target: "inventory", databaseId: "inventory-v2" },
                { binding: "FILES", type: "r2_bucket", target: "uploads" },
              ],
              connectors: {
                grants: {},
                revision: 2,
                appliedRevision: 1,
                state: "failed",
                error: "Synthetic activation failure",
              },
              activeConnectors: { ERP: { connector: "erp", entrypoint: "default" } },
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
                grants: { ERP: { connector: "erp", entrypoint: "default" } },
                revision: superseded && request.method === "GET" ? 3 : 2,
                appliedRevision: request.method === "GET" && outcome === "active" ? 2 : 1,
                state: request.method === "GET" ? outcome : "pending",
                error: outcome === "failed" ? "Synthetic activation failure" : null,
              }),
            );
        } else if (request.url?.startsWith("/api/v1/connectors/erp")) {
          if (request.method === "PUT" && uploadFailures-- > 0) {
            response.writeHead(503).end(JSON.stringify({ message: "Synthetic transient failure" }));

            return;
          }

          if (rejected && request.method !== "GET")
            response
              .writeHead(403)
              .end(JSON.stringify({ message: "Administrator permission is required" }));
          else
            response.end(
              JSON.stringify({
                name: "erp",
                checksum: "a".repeat(64),
                appliedChecksum: "a".repeat(64),
                jobId:
                  superseded && request.method === "GET"
                    ? "00000000-0000-4000-8000-000000000006"
                    : "00000000-0000-4000-8000-000000000005",
                state:
                  request.method === "GET"
                    ? outcome === "active"
                      ? "succeeded"
                      : outcome
                    : "queued",
                message: outcome === "failed" ? "Synthetic activation failure" : null,
                entrypoints: ["default"],
                secrets: ["API_KEY"],
                secretRevision: 2,
                appliedSecretRevision: 2,
              }),
            );
        } else response.writeHead(404).end();
      });
    });

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet-connector-cli-"));
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
      uploadFailures = 0;
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

    const cli = (...args: string[]) => command("connector", ...args);

    it("deploys the bundled source map and reuses the build identity for unchanged code", async () => {
      await writeFile(
        join(directory, "worker.ts"),
        `import { WorkerEntrypoint } from 'cloudflare:workers';
export default class Connector extends WorkerEntrypoint {
  fail(): never { throw new Error('mapped fixture'); }
}`,
      );
      await writeFile(
        join(directory, "connector.jsonc"),
        JSON.stringify({
          name: "erp",
          main: "worker.ts",
          compatibility_date: "2026-10-01",
        }),
      );
      uploadFailures = 1;
      await cli("deploy", "--config", "connector.jsonc", "--no-wait");
      expect(requests).toHaveLength(2);
      const requestId = z.uuid().parse(requests[0]?.requestId);
      expect(requests[1]?.requestId).toBe(requestId);

      const uploadedParts = await Promise.all(
        requests.map(async (request) => {
          const form = await new Response(request.body, {
            headers: { "content-type": request.contentType },
          }).formData();

          return Promise.all(
            [...form].map(async ([name, part]) => [
              name,
              part instanceof File ? await part.text() : part,
            ]),
          );
        }),
      );

      expect(uploadedParts[0]).toEqual(uploadedParts[1]);

      const readUpload = async () => {
        const request = requests.at(-1);
        expect(request?.contentType).toMatch(/^multipart\/form-data; boundary=/);

        const form = await new Response(request?.body, {
          headers: { "content-type": request?.contentType ?? "" },
        }).formData();

        const metadata = contract.connectorUploadMetadata.parse(
          JSON.parse(z.string().parse(form.get("metadata"))),
        );

        const modules = [];

        for (const [name, file] of form.entries()) {
          if (name === "metadata") continue;
          const part = z.instanceof(File).parse(file);
          modules.push({ name, type: part.type, source: await part.text() });
        }

        return { metadata, modules };
      };

      const release = await readUpload();
      const map = release.modules.find((module) => module.type === "application/source-map+json");
      expect(map).toBeDefined();
      expect(release.metadata.debug?.source_maps).toEqual({ "worker.js": map?.name });
      expect(JSON.parse(map?.source ?? "")).toMatchObject({
        version: 3,
        sources: ["../worker.ts"],
        sourcesContent: [expect.stringContaining("fail(): never")],
      });
      expect(
        release.modules.find((module) => module.type === "application/javascript+module")?.source,
      ).not.toContain("sourceMappingURL");
      await cli("deploy", "--config", "connector.jsonc", "--no-wait");
      const repeated = await readUpload();
      expect(requests.at(-1)?.requestId).not.toBe(requestId);
      expect(repeated.metadata.debug?.build_id).toBe(release.metadata.debug?.build_id);
      expect(repeated.modules).toEqual(release.modules);
    });
    it("browses the catalog and reads serving app resources without mutations", async () => {
      expect(JSON.parse((await cli("catalog")).stdout)).toEqual([
        { name: "erp", entrypoints: ["default"] },
        { name: "pending", entrypoints: [] },
      ]);
      expect(JSON.parse((await command("connections")).stdout)).toMatchObject({
        resources: [
          { binding: "DB", type: "d1", target: "inventory", databaseId: "inventory-v2" },
          { binding: "FILES", type: "r2_bucket", target: "uploads" },
        ],
        connectors: { grants: {}, state: "failed" },
        activeConnectors: { ERP: { connector: "erp" } },
      });
      expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "GET /api/v1/connector-catalog",
        "GET /api/v1/apps/by-name/inventory",
        `GET /api/v1/apps/${app.id}/connections`,
      ]);
      expect(
        requests.every((request) => request.authorization === "Bearer normal-credential"),
      ).toBe(true);
    });

    it("reads secret files verbatim, lists names, deletes and reports activation failures", async () => {
      const value = "synthetic-secret\nwith-trailing-newline\n";
      const file = join(directory, "secret.txt");
      await writeFile(file, value);
      const result = await cli("secret", "put", "erp", "API_KEY", "--file", file);
      expect(JSON.parse(result.stdout)).toMatchObject({ state: "succeeded", secrets: ["API_KEY"] });
      expect(result.stdout + result.stderr).not.toContain(value);
      expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ value });
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "PUT /api/v1/connectors/erp/secrets/API_KEY",
        "GET /api/v1/connectors/erp",
      ]);
      expect(JSON.parse((await cli("secret", "list", "erp")).stdout)).toMatchObject({
        secrets: ["API_KEY"],
      });
      await cli("secret", "delete", "erp", "API_KEY", "--no-wait");
      expect(requests.at(-1)).toMatchObject({ method: "DELETE", body: "" });
      const piped = cli("secret", "put", "erp", "API_KEY", "--no-wait");
      piped.child.stdin?.end(value);
      expect((await piped).stdout).not.toContain(value);
      expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({ value });
      outcome = "failed";
      await expect(cli("secret", "put", "erp", "API_KEY", "--file", file)).rejects.toThrow(
        "Synthetic activation failure",
      );
      outcome = "active";
      superseded = true;
      await expect(cli("secret", "delete", "erp", "API_KEY")).rejects.toThrow(
        "newer connector change",
      );
      superseded = false;
      rejected = true;
      await expect(cli("secret", "put", "erp", "API_KEY", "--file", file)).rejects.toThrow(
        "Administrator permission",
      );
      await writeFile(file, "");
      await expect(cli("secret", "put", "erp", "API_KEY", "--file", file)).rejects.toThrow(
        "1–5000",
      );
    }, 15000);

    it("limits secret files and stdin to 5000 UTF-8 bytes before sending a request", async () => {
      const file = join(directory, "bounded-secret.txt");

      for (const value of ["x".repeat(5000), "é".repeat(2500)]) {
        await writeFile(file, value);
        await cli("secret", "put", "erp", "API_KEY", "--file", file, "--no-wait");
        expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({ value });
        const piped = cli("secret", "put", "erp", "API_KEY", "--no-wait");
        piped.child.stdin?.end(value);
        await piped;
        expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({ value });

        const before = requests.length;
        await writeFile(file, value + "é");
        await expect(
          cli("secret", "put", "erp", "API_KEY", "--file", file, "--no-wait"),
        ).rejects.toThrow("1–5000 UTF-8 bytes");
        const oversized = cli("secret", "put", "erp", "API_KEY", "--no-wait");
        oversized.child.stdin?.end(value + "é");
        await expect(oversized).rejects.toThrow("1–5000 UTF-8 bytes");
        expect(requests).toHaveLength(before);
      }
    });

    it("uses project context, direct binding names and the ordinary credential, then waits for activation", async () => {
      expect(JSON.parse((await cli("bind", "erp", "--as", "ERP")).stdout)).toMatchObject({
        state: "active",
        appliedRevision: 2,
      });
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /api/v1/apps/by-name/inventory",
        `PUT /api/v1/apps/${app.id}/bindings/ERP`,
        `GET /api/v1/apps/${app.id}/bindings`,
      ]);
      expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
        connector: "erp",
        entrypoint: "default",
      });
      expect(
        requests.every((request) => request.authorization === "Bearer normal-credential"),
      ).toBe(true);
    });
    it("supports named entrypoints, explicit app names, removal and no-wait without manual revisions", async () => {
      await cli(
        "bind",
        "erp",
        "--as",
        "ERP",
        "--entrypoint",
        "Reader",
        "--app",
        app.slug,
        "--no-wait",
      );
      expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
        connector: "erp",
        entrypoint: "Reader",
      });
      expect(requests).toHaveLength(2);
      requests.length = 0;
      await cli("unbind", "ERP", "--app", app.slug, "--no-wait");
      expect(requests[1]).toMatchObject({
        method: "DELETE",
        path: `/api/v1/apps/${app.id}/bindings/ERP`,
        body: "",
      });
    });
    it("reads bindings without mutation and exposes authorization and activation failures", async () => {
      expect(JSON.parse((await cli("bindings")).stdout)).toMatchObject({
        grants: { ERP: { connector: "erp" } },
      });
      expect(requests.every((request) => request.method === "GET")).toBe(true);
      rejected = true;
      await expect(cli("bind", "erp", "--as", "ERP")).rejects.toThrow("Administrator permission");
      rejected = false;
      outcome = "failed";
      await expect(cli("bind", "erp", "--as", "ERP")).rejects.toThrow(
        "Synthetic activation failure",
      );
      outcome = "pending";
      superseded = true;
      await expect(cli("unbind", "ERP")).rejects.toThrow("newer binding change");
    });
  },
);
