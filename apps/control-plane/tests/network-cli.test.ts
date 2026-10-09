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

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")(
  "Network CLI and combined login scopes",
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

    const requests: { path: string; method: string; authorization: string; body: string }[] = [];
    let directory: string;
    let origin: string;
    let rejection = false;
    let outcome = "active";

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

        if (request.url === "/api/auth/device/code") {
          response.end(
            JSON.stringify({
              device_code: "fixture-device",
              user_code: "TEST-CODE",
              verification_uri: `${origin}/device`,
              expires_in: 60,
              interval: 1,
            }),
          );
        } else if (request.url === "/api/auth/oauth2/token") {
          response.writeHead(400).end(JSON.stringify({ error: "access_denied" }));
        } else if (
          request.url === "/api/v1/apps/by-name/inventory" ||
          request.url === "/api/v1/apps/by-name/other"
        ) {
          response.end(JSON.stringify(app));
        } else if (request.url === `/api/v1/apps/${app.id}/network`) {
          if (rejection)
            response
              .writeHead(403)
              .end(JSON.stringify({ message: "The token lacks network:manage" }));
          else
            response.end(
              JSON.stringify({
                policy: { backend: ["https://api.example.test"], browser: [] },
                revision: 4,
                appliedRevision: request.method === "PATCH" || outcome !== "active" ? 3 : 4,
                state: request.method === "PATCH" ? "pending" : outcome,
                error: outcome === "failed" ? "Synthetic activation failure" : null,
              }),
            );
        } else response.writeHead(404).end();
      });
    });

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet-network-cli-"));
      await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify({ name: "inventory" }));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
    });
    beforeEach(() => {
      requests.length = 0;
      rejection = false;
      outcome = "active";
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
        args,
        {
          cwd: directory,
          timeout: 10000,
          env: {
            ...process.env,
            PLATFORM_URL: origin,
            PLATFORM_ACCESS_TOKEN: "fixture-normal-token",
            PLATFORM_SESSION_FILE:
              process.platform === "win32"
                ? undefined
                : join(directory, "credentials", "session.json"),
          },
        },
      );

    it("resolves project context and waits for an incremental change using the ordinary credential", async () => {
      const result = await cli("network", "allow", "https://api.example.test");
      expect(JSON.parse(result.stdout)).toMatchObject({ state: "active", appliedRevision: 4 });
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /api/v1/apps/by-name/inventory",
        `PATCH /api/v1/apps/${app.id}/network`,
        `GET /api/v1/apps/${app.id}/network`,
      ]);
      expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
        target: "backend",
        action: "allow",
        origins: ["https://api.example.test"],
      });
      expect(
        requests.every((request) => request.authorization === "Bearer fixture-normal-token"),
      ).toBe(true);
    });
    it("accepts an explicit name, multiple origins and browser selection without waiting", async () => {
      await cli(
        "network",
        "deny",
        "https://one.example.test",
        "https://two.example.test",
        "--browser",
        "--app",
        "other",
        "--no-wait",
      );
      expect(requests[0]?.path).toBe("/api/v1/apps/by-name/other");
      expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
        target: "browser",
        action: "deny",
        origins: ["https://one.example.test", "https://two.example.test"],
      });
      expect(requests).toHaveLength(2);
    });
    it("shows state without writing and reports scope failures without a retry", async () => {
      expect(JSON.parse((await cli("network")).stdout)).toMatchObject({ state: "active" });
      expect(requests.every((request) => request.method === "GET")).toBe(true);
      rejection = true;
      await expect(cli("network", "allow", "https://api.example.test")).rejects.toThrow(
        "network:manage",
      );
      expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    });
    it("returns a failure when activation fails", async () => {
      outcome = "failed";
      await expect(cli("network", "allow", "https://api.example.test")).rejects.toMatchObject({
        code: 1,
      });
    });
    it.each([
      { args: [], scopes: ["platform:read", "platform:write"] },
      {
        args: ["--scope", "platform:read", "network:manage"],
        scopes: ["platform:read", "network:manage"],
      },
      {
        args: ["--scope", "platform:read,platform:write,network:manage"],
        scopes: ["platform:read", "platform:write", "network:manage"],
      },
    ])("uses one login with the requested scopes: $scopes", async ({ args, scopes }) => {
      await expect(cli("login", ...args)).rejects.toThrow("Device login was denied");
      expect(new URLSearchParams(requests[0]?.body).get("scope")?.split(" ")).toEqual([
        "openid",
        "profile",
        "offline_access",
        ...scopes,
      ]);
    });
  },
);
