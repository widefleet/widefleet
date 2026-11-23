import { esbuildBinary } from "../../../tools/cli-tools.ts";
import * as contract from "@platform/contracts";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { executeCli } from "./cli-process.ts";

const execute = promisify(execFile);

const describeCli = describe.runIf(process.env["RUN_CLI_TESTS"] === "1");

// Allow multiple native commands, each with its own 10-second process deadline.

// The CLI sends API documentation as its own upload part.
const uploadedDocumentation = async (form: FormData) =>
  contract.serviceDocumentation.parse(
    JSON.parse(await z.instanceof(File).parse(form.get(contract.serviceDocumentationPart)).text()),
  );

describeCli("App services CLI", { timeout: 30_000 }, () => {
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

  const service = contract.serviceCatalogEntry.parse({
    appId: "00000000-0000-4000-8000-000000000099",
    slug: "erp-app",
    displayName: "ERP",
    entrypoints: ["Reader"],
    accessMode: "approval_required",
  });

  let catalog = [service];

  // Deployed apps that the catalog omits, such as a web app with an undocumented default handler.
  let unlisted: (typeof service)[] = [];

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
  let declarations = "export interface INVENTORY {}";

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
      else if (request.url?.startsWith("/api/v1/app-services/erp-app/types?")) {
        const query = new URL(request.url, "http://cli.test").searchParams;
        response.end(
          JSON.stringify({
            ...service,
            deploymentId: app.activeDeploymentId,
            entrypoint: query.get("entrypoint"),
            binding: query.get("binding"),
            declarations,
          }),
        );
      } else if (request.url === "/api/v1/app-services") {
        response.end(JSON.stringify(catalog));
      } else if (request.method === "GET" && request.url?.startsWith("/api/v1/app-services/")) {
        // Mirror the service description lookup: an app ID wins over a UUID-shaped slug.
        const url = new URL(request.url, "http://cli.test");
        const target = decodeURIComponent(url.pathname.slice("/api/v1/app-services/".length));
        const deployed = [...catalog, ...unlisted];

        const entry =
          deployed.find((candidate) => candidate.appId === target.toLowerCase()) ??
          deployed.find((candidate) => candidate.slug === target);

        if (!entry) {
          response.statusCode = 404;
          response.end(JSON.stringify({ message: "App service not found" }));
        } else
          response.end(
            JSON.stringify({
              ...entry,
              deploymentId: app.activeDeploymentId,
              documented: true,
              methods: [{ entrypoint: "Reader", name: "read", summary: "Read inventory" }],
              documentation: url.searchParams.has("methods[]")
                ? {
                    entrypoint: { name: "Reader", summary: "Read inventory" },
                    types: [],
                    omittedTypes: [],
                  }
                : null,
            }),
          );
      } else if (
        request.method === "PUT" &&
        [...catalog, ...unlisted].some(
          (entry) => request.url === `/api/v1/app-services/${entry.appId}/access`,
        )
      ) {
        response.end(body);
      } else if (request.url?.startsWith("/api/v1/connection-requests")) {
        response.end(
          JSON.stringify(
            request.method === "GET"
              ? []
              : {
                  id: app.id,
                  status: request.url.endsWith("approve")
                    ? "approved"
                    : request.url.endsWith("reject")
                      ? "rejected"
                      : "pending",
                },
          ),
        );
      } else if (request.method === "POST" && request.url === "/api/v1/apps/source-target") {
        response.end(JSON.stringify({ supported: false, branch: "main", preview: false }));
      } else if (
        request.method === "POST" &&
        request.url === `/api/v1/apps/${app.id}/source/prepare`
      ) {
        response.end(JSON.stringify({ organizationId: app.organizationId, repository: null }));
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
            required: ["API_KEY", "TOKEN"],
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
    catalog = [service];
    unlisted = [];
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
    executeCli(executable, args, {
      cwd: directory,
      timeout: 10000,
      env: { ...process.env, PLATFORM_URL: origin, PLATFORM_ACCESS_TOKEN: "normal-credential" },
    });

  it("requests a connection without binding and exposes administrator decisions and availability", async () => {
    const requested = await command(
      "connect",
      "erp-app",
      "--app",
      "inventory",
      "--as",
      "ERP",
      "--entrypoint",
      "Reader",
      "--request",
    );

    expect(JSON.parse(requested.stdout)).toMatchObject({ status: "pending" });
    expect(requests.some((entry) => entry.path.includes("/bindings/"))).toBe(false);
    expect(
      JSON.parse(
        requests.find((entry) => entry.path === "/api/v1/connection-requests")?.body ?? "null",
      ),
    ).toEqual({
      appId: app.id,
      app: "00000000-0000-4000-8000-000000000099",
      binding: "ERP",
      entrypoint: "Reader",
    });
    expect(JSON.parse((await command("services", "requests")).stdout)).toEqual([]);
    expect(JSON.parse((await command("services", "approve", app.id)).stdout)).toMatchObject({
      status: "approved",
    });
    expect(JSON.parse((await command("services", "reject", app.id)).stdout)).toMatchObject({
      status: "rejected",
    });
    expect(
      JSON.parse((await command("services", "access", "erp-app", "--mode", "organization")).stdout),
    ).toEqual({ accessMode: "organization" });
    expect(
      JSON.parse(
        (await command("services", "access", "erp-app", "--mode", "approval-required")).stdout,
      ),
    ).toEqual({ accessMode: "approval_required" });
    expect(requests.every((entry) => entry.authorization === "Bearer normal-credential")).toBe(
      true,
    );
  });

  it.each([
    {
      target: "a0000000-0000-4000-8000-000000000099",
      expected: "a0000000-0000-4000-8000-000000000099",
    },
    {
      target: "A0000000-0000-4000-8000-000000000099",
      expected: "a0000000-0000-4000-8000-000000000099",
    },
    { target: "erp-app", expected: "a0000000-0000-4000-8000-000000000099" },
    {
      target: "b0000000-0000-4000-8000-000000000099",
      expected: "00000000-0000-4000-8000-000000000100",
    },
  ])(
    "resolves colliding API identifiers for availability and connections: $target",
    async ({ target, expected }) => {
      catalog = [
        { ...service, slug: "a0000000-0000-4000-8000-000000000099", displayName: "Colliding slug" },
        {
          ...service,
          appId: "00000000-0000-4000-8000-000000000100",
          slug: "b0000000-0000-4000-8000-000000000099",
          displayName: "UUID-shaped slug",
        },
        { ...service, appId: "a0000000-0000-4000-8000-000000000099" },
      ];
      await command("services", "access", target, "--mode", "organization");
      expect(requests.filter((entry) => entry.method === "PUT")).toMatchObject([
        {
          path: `/api/v1/app-services/${expected}/access`,
          body: JSON.stringify({ accessMode: "organization" }),
        },
      ]);
      await command(
        "connect",
        target,
        "--app",
        "inventory",
        "--as",
        "ERP",
        "--entrypoint",
        "Reader",
        "--request",
      );
      const requested = requests.findLast((entry) => entry.path === "/api/v1/connection-requests");
      expect(requested?.method).toBe("POST");
      expect(JSON.parse(requested?.body ?? "null")).toEqual({
        appId: app.id,
        app: expected,
        binding: "ERP",
        entrypoint: "Reader",
      });
      await command(
        "connect",
        target,
        "--app",
        "inventory",
        "--as",
        "ERP",
        "--entrypoint",
        "Reader",
        "--no-wait",
      );
      const connected = requests.findLast((entry) => entry.path.endsWith("/bindings/ERP"));
      expect(connected?.method).toBe("PUT");
      expect(JSON.parse(connected?.body ?? "null")).toEqual({
        app: expected,
        entrypoint: "Reader",
      });
    },
  );

  it("does not change availability when the requested API is absent", async () => {
    await expect(
      command("services", "access", "missing-api", "--mode", "organization"),
    ).rejects.toHaveProperty("stderr", expect.stringContaining("App service not found"));
    expect(requests.filter((entry) => entry.method !== "GET")).toEqual([]);
  });

  it("connects an explicit entrypoint of an app that the catalog omits", async () => {
    const web = {
      ...service,
      appId: "00000000-0000-4000-8000-000000000101",
      slug: "web-app",
      entrypoints: ["default"],
    };

    unlisted = [web];
    expect(JSON.parse((await command("services")).stdout)).toEqual(catalog);
    await command("connect", "web-app", "--app", "inventory", "--as", "WEB", "--no-wait");
    const connected = requests.findLast((entry) => entry.path.endsWith("/bindings/WEB"));
    expect(connected?.method).toBe("PUT");
    expect(JSON.parse(connected?.body ?? "null")).toEqual({
      app: web.appId,
      entrypoint: "default",
    });
  });

  it.each([
    {
      name: "default RPC export",
      source:
        "import {WorkerEntrypoint} from 'cloudflare:workers'; export default class extends WorkerEntrypoint {read(){return 'value';}}",
      entrypoints: ["default"],
      web: true,
      assets: false,
      workflows: [],
    },
    {
      name: "re-exported service and web handler",
      source:
        "import {WorkerEntrypoint} from 'cloudflare:workers'; class Service extends WorkerEntrypoint {read(){return 'value';}} export {Service as Reader}; export default {fetch(){return new Response('web');}};",
      entrypoints: ["Reader", "default"],
      web: true,
      assets: false,
      workflows: [],
    },
    {
      name: "service alongside a workflow",
      source:
        "import {WorkerEntrypoint, WorkflowEntrypoint} from 'cloudflare:workers'; export class Reader extends WorkerEntrypoint {read(){return 'value';}} export class Job extends WorkflowEntrypoint {async run(){return 'done';}}",
      entrypoints: ["Reader"],
      web: false,
      assets: false,
      workflows: [{ binding: "JOBS", name: "jobs", class_name: "Job" }],
    },
    {
      name: "static assets without a default handler",
      source: "export {};",
      entrypoints: [],
      web: true,
      assets: true,
      workflows: [],
    },
  ])("derives app metadata from standard Worker exports: $name", async (fixture) => {
    await writeFile(join(directory, "inferred.ts"), fixture.source);

    if (fixture.assets) {
      await mkdir(join(directory, "public"), { recursive: true });
      await writeFile(join(directory, "public/index.html"), "Static app");
    }

    await writeFile(
      join(directory, "inferred.jsonc"),
      JSON.stringify({
        name: app.slug,
        main: "inferred.ts",
        compatibility_date: "2026-10-01",
        workflows: fixture.workflows,
        assets: fixture.assets ? { directory: "public", binding: "ASSETS" } : undefined,
      }),
    );
    const result = await command("deploy", "--config", "inferred.jsonc", "--no-wait", "--json");
    expect(JSON.parse(result.stdout)).toMatchObject({ url: fixture.web ? app.url : null });
    const upload = requests.find((entry) => entry.path.endsWith("/worker"));

    const form = await new Response(upload?.body, {
      headers: { "content-type": upload?.contentType ?? "" },
    }).formData();

    const metadata = contract.workerMetadata.parse(
      JSON.parse(z.string().parse(form.get("metadata"))),
    );

    const documentation = await uploadedDocumentation(form);

    expect(metadata.entrypoints ?? []).toEqual(fixture.entrypoints);
    expect(metadata.web).toBe(fixture.web);
    expect(documentation.format).toBe(3);

    if (fixture.entrypoints.includes("Reader"))
      expect(
        documentation.entrypoints.find((entry) => entry.name === "Reader")?.methods[0]?.name,
      ).toBe("read");
  });

  it.each([
    {
      name: "excess overloads",
      source: `${Array.from({ length: 17 }, (_, index) => `read(input: ${index}): ${index};`).join("\n")} read(input: number) { return input; }`,
      warning: "Only the first 16 overloads",
      signatures: 16,
    },
    {
      name: "oversized comment",
      source: `/** ${"x".repeat(262145)} */ read() { return 1; }`,
      warning: "API documentation was omitted",
      signatures: 0,
    },
  ])("deploys valid code when documentation exceeds limits: $name", async (fixture) => {
    await writeFile(
      join(directory, "bounded.ts"),
      `import {WorkerEntrypoint} from "cloudflare:workers"; export class Reader extends WorkerEntrypoint {\n${fixture.source}\n}`,
    );
    await writeFile(
      join(directory, "bounded.jsonc"),
      JSON.stringify({ name: app.slug, main: "bounded.ts", compatibility_date: "2026-10-01" }),
    );
    const result = await command("deploy", "--config", "bounded.jsonc", "--no-wait", "--json");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "queued" });
    const upload = requests.find((entry) => entry.path.endsWith("/worker"));

    const form = await new Response(upload?.body, {
      headers: { "content-type": upload?.contentType ?? "" },
    }).formData();

    const metadata = contract.workerMetadata.parse(
      JSON.parse(z.string().parse(form.get("metadata"))),
    );

    expect(metadata.entrypoints).toEqual(["Reader"]);
    expect(result.stderr).toContain(fixture.warning);
    expect(
      (await uploadedDocumentation(form)).entrypoints[0]?.methods[0]?.signatures.length ?? 0,
    ).toBe(fixture.signatures);
  });

  it("reads API documentation through the authenticated service endpoint", async () => {
    const result = await command("services", "describe", "erp-app");
    expect(JSON.parse(result.stdout)).toMatchObject({
      slug: "erp-app",
      methods: [{ entrypoint: "Reader", name: "read" }],
      documentation: null,
    });
    expect(requests[0]).toMatchObject({
      path: "/api/v1/app-services/erp-app",
      method: "GET",
      authorization: "Bearer normal-credential",
    });

    const selected = await command(
      "services",
      "describe",
      "erp-app",
      "--entrypoint",
      "Reader",
      "--method",
      "read",
      "--method",
      "count",
      "--type",
      "Page<T, U>",
    );

    expect(JSON.parse(selected.stdout)).toMatchObject({
      documentation: { entrypoint: { name: "Reader" } },
    });
    const query = new URL(requests[1]?.path ?? "", "http://cli.test").searchParams;
    expect(query.get("entrypoint")).toBe("Reader");
    expect(query.getAll("methods[]")).toEqual(["read", "count"]);
    // Type names can contain commas, so each is its own parameter.
    expect(query.getAll("types[]")).toEqual(["Page<T, U>"]);
  });

  it("writes binding types and checks them against the active deployment", async () => {
    declarations = "export interface INVENTORY {}";
    const printed = await command("services", "types", "erp-app", "--as", "INVENTORY");
    expect(printed.stdout).toBe(`${declarations}\n`);
    const query = new URL(requests[0]?.path ?? "", "http://cli.test");
    expect(query.pathname).toBe("/api/v1/app-services/erp-app/types");
    expect(query.searchParams.get("binding")).toBe("INVENTORY");
    expect(query.searchParams.get("entrypoint")).toBe("default");

    const file = join(directory, "inventory.d.ts");

    const types = (...args: string[]) =>
      command(
        "services",
        "types",
        "erp-app",
        "--entrypoint",
        "Reader",
        "--as",
        "INVENTORY",
        ...args,
      );

    await rm(file, { force: true });
    await expect(types("--output", file, "--check")).rejects.toHaveProperty(
      "stderr",
      expect.stringContaining("does not match the API of erp-app's active deployment"),
    );
    await types("--output", file);
    expect(await readFile(file, "utf8")).toBe(`${declarations}\n`);
    await types("--output", file, "--check");
    // A checkout that converts line endings still matches.
    await writeFile(file, `${declarations}\r\n`);
    await types("--output", file, "--check");

    // A provider change, such as a renamed type, makes the file stale.
    declarations = "export interface INVENTORY { read(): Promise<string>; }";
    await expect(types("--output", file, "--check")).rejects.toHaveProperty(
      "stderr",
      expect.stringContaining("run the command without --check to update it"),
    );
    expect(await readFile(file, "utf8")).toBe("export interface INVENTORY {}\r\n");
    await expect(
      command("services", "types", "erp-app", "--as", "INVENTORY", "--check"),
    ).rejects.toHaveProperty("stderr", expect.stringContaining("--output"));
  });

  it("rejects the nonstandard widefleet Wrangler property", async () => {
    await writeFile(
      join(directory, "invalid.jsonc"),
      JSON.stringify({
        main: "service.ts",
        compatibility_date: "2026-10-01",
        widefleet: { web: false, entrypoints: ["Reader"] },
      }),
    );
    await expect(
      command("deploy", "--config", "invalid.jsonc", "--no-wait"),
    ).rejects.toHaveProperty("stderr", expect.stringContaining("unknown field `widefleet`"));
    expect(requests.some((entry) => entry.path.endsWith("/worker"))).toBe(false);
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
        required: ["API_KEY", "TOKEN"],
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
