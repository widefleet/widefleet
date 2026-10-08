import * as contract from "@platform/contracts";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")("App access CLI", () => {
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

  const previewId = "00000000-0000-4000-8000-000000000004";
  const requests: { path: string; method: string; authorization: string; body: string }[] = [];
  let directory: string;
  let origin: string;
  let groups: string[] = [];
  let allAuthenticated = false;
  let written = false;
  let polls = 0;
  let rejection = 0;
  let inherited = false;
  let unpublished = false;
  let failed = false;
  let superseded = false;

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
        body,
      });
      response.setHeader("content-type", "application/json");

      if (request.url === "/api/v1/apps/by-name/inventory") {
        response.end(JSON.stringify(app));

        return;
      }

      if (request.url !== `/api/v1/apps/${app.id}/access`) {
        response.writeHead(404).end();

        return;
      }

      if (request.method === "PATCH") {
        if (rejection) {
          response
            .writeHead(rejection)
            .end(JSON.stringify({ message: "Synthetic access rejection" }));

          return;
        }

        const change = contract.appAccessChange.safeParse(JSON.parse(body));

        if (!change.success || change.data.revision !== 2) {
          response.writeHead(400).end(JSON.stringify({ message: "Invalid access change" }));

          return;
        }

        written = true;
        allAuthenticated = change.data.allAuthenticated;
      } else if (written) polls += 1;

      const revision = written ? (superseded && polls > 0 ? 4 : 3) : 2;
      const state = unpublished ? "saved" : written && polls === 0 ? "pending" : "active";

      const previewState = written
        ? failed
          ? "failed"
          : polls < 2
            ? "pending"
            : "active"
        : "active";

      response.end(
        JSON.stringify(
          contract.appAccessState.parse({
            groups,
            users: [],
            provider: "https://login.example.test",
            allAuthenticated,
            revision,
            appliedRevision: state === "active" ? revision : null,
            state,
            error: null,
            inheritedFrom: inherited ? previewId : null,
            canManage: !inherited,
            previews:
              unpublished || inherited
                ? []
                : [
                    {
                      appId: previewId,
                      hostname: "review.inventory.apps.localhost",
                      groups,
                      users: [],
                      provider: "https://login.example.test",
                      allAuthenticated,
                      revision,
                      appliedRevision: previewState === "active" ? revision : 2,
                      state: previewState,
                      error: previewState === "failed" ? "Synthetic proxy failure" : null,
                    },
                  ],
          }),
        ),
      );
    });
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "widefleet-access-cli-"));
    await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify({ name: app.slug }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
  });
  beforeEach(() => {
    requests.length = 0;
    groups = ["original-group"];
    allAuthenticated = false;
    written = false;
    polls = 0;
    rejection = 0;
    inherited = false;
    unpublished = false;
    failed = false;
    superseded = false;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });

  const cli = (...args: string[]) =>
    execute(
      process.env["CLI_BINARY"] ??
        fileURLToPath(
          new URL(
            `../../../target/debug/widefleet${process.platform === "win32" ? ".exe" : ""}`,
            import.meta.url,
          ),
        ),
      ["access", ...args],
      {
        cwd: directory,
        timeout: 10000,
        env: {
          ...process.env,
          PLATFORM_URL: origin,
          PLATFORM_ACCESS_TOKEN: "fixture-access-token",
          WIDEFLEET_TELEMETRY_DISABLED: "1",
        },
      },
    );

  it("shows groups and automatic inheritance without writing", async () => {
    expect(JSON.parse((await cli()).stdout)).toMatchObject({
      groups: ["original-group"],
      previews: [{ groups: ["original-group"] }],
    });
    inherited = true;
    expect(JSON.parse((await cli("show", "--app", app.id, "--json")).stdout)).toMatchObject({
      inheritedFrom: previewId,
      canManage: false,
    });
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("sets the audience using project context and waits for inherited preview activation", async () => {
    const result = await cli("set", "--all-authenticated", "true");
    expect(JSON.parse(result.stdout)).toMatchObject({
      allAuthenticated: true,
      state: "active",
      previews: [{ allAuthenticated: true, state: "active" }],
    });
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/v1/apps/by-name/inventory",
      `GET /api/v1/apps/${app.id}/access`,
      `PATCH /api/v1/apps/${app.id}/access`,
      `GET /api/v1/apps/${app.id}/access`,
      `GET /api/v1/apps/${app.id}/access`,
    ]);
    expect(JSON.parse(requests[2]?.body ?? "")).toEqual({
      allAuthenticated: true,
      revision: 2,
    });
    expect(
      requests.every((request) => request.authorization === "Bearer fixture-access-token"),
    ).toBe(true);
  });

  it("explicitly broadens the audience without waiting or writing to previews", async () => {
    const result = await cli("set", "--all-authenticated", "true", "--app", app.id, "--no-wait");
    expect(JSON.parse(result.stdout)).toMatchObject({ allAuthenticated: true, state: "pending" });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "PATCH"]);
    expect(JSON.parse(requests[1]?.body ?? "")).toEqual({ allAuthenticated: true, revision: 2 });
  });

  it.each([
    ["set"],
    ["set", "--all-authenticated", "true", "--all-authenticated"],
    ["set", "--previews", "--all-authenticated", "true"],
  ])("rejects ambiguous or separate preview settings: %s", async (...args) => {
    await expect(cli(...args)).rejects.toMatchObject({ code: 2 });
    expect(requests).toHaveLength(0);
  });

  it("rejects edits on a preview and identifies its original app", async () => {
    inherited = true;
    await expect(cli("set", "--all-authenticated", "true", "--app", app.id)).rejects.toThrow(
      `Change the original app with --app ${previewId}`,
    );
    expect(requests.map(({ method }) => method)).toEqual(["GET"]);
  });

  it.each([403, 409])("preserves API rejection %s without retrying a write", async (status) => {
    rejection = status;
    await expect(cli("set", "--all-authenticated", "true")).rejects.toThrow(
      "Synthetic access rejection",
    );
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("reports failed preview activation and superseding changes", async () => {
    failed = true;
    await expect(cli("set", "--all-authenticated", "true")).rejects.toThrow(
      "Preview review.inventory.apps.localhost: Synthetic proxy failure",
    );
    written = false;
    polls = 0;
    failed = false;
    superseded = true;
    await expect(cli("set", "--all-authenticated", "false")).rejects.toThrow(
      "A newer access change was saved",
    );
  });

  it("stores rules for an unpublished app without waiting for its first deployment", async () => {
    unpublished = true;
    expect(JSON.parse((await cli("set", "--all-authenticated", "true")).stdout)).toMatchObject({
      state: "saved",
      allAuthenticated: true,
    });
    expect(polls).toBe(0);
  });
});
