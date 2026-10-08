import * as contract from "@platform/contracts";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")("App roles CLI", () => {
  const appId = "00000000-0000-4000-8000-000000000001";
  const assignmentId = "00000000-0000-4000-8000-000000000002";

  const state = contract.appRoleState.parse({
    appId,
    inheritedFrom: null,
    revision: 7,
    assignments: [
      {
        id: assignmentId,
        principal: { type: "user", provider: "https://login.example.test", subject: "creator" },
        role: "owner",
      },
    ],
    actions: ["read", "roles", "transfer"],
    provider: "https://login.example.test",
  });

  const requests: { path: string; method: string; body: string }[] = [];
  let origin = "";
  let rejection = false;
  let inherited = false;

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ path: request.url ?? "", method: request.method ?? "", body });
      response.setHeader("content-type", "application/json");

      if (request.headers.authorization !== "Bearer fixture-token") {
        response.writeHead(401).end();

        return;
      }

      if (rejection && request.method !== "GET") {
        response.writeHead(409).end(JSON.stringify({ message: "Permissions changed" }));

        return;
      }

      response.end(JSON.stringify({ ...state, inheritedFrom: inherited ? assignmentId : null }));
    });
  });

  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
  });
  beforeEach(() => {
    requests.length = 0;
    rejection = false;
    inherited = false;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const cli = (...args: string[]) =>
    execute(
      process.env["CLI_BINARY"] ??
        fileURLToPath(new URL("../../../target/debug/widefleet", import.meta.url)),
      ["roles", "--app", appId, "--json", ...args],
      {
        timeout: 10_000,
        env: {
          ...process.env,
          PLATFORM_URL: origin,
          PLATFORM_ACCESS_TOKEN: "fixture-token",
          WIDEFLEET_TELEMETRY_DISABLED: "1",
        },
      },
    );

  it("reads roles and grants a scoped group role with the observed revision", async () => {
    expect(JSON.parse((await cli("show")).stdout)).toEqual(state);
    await cli("grant", "--group", "engineering", "--role", "developer");
    const write = requests.find((request) => request.method === "POST");
    expect(write?.path).toBe(`/api/v1/apps/${appId}/roles`);
    expect(contract.appRoleGrant.parse(JSON.parse(write?.body ?? ""))).toEqual({
      principal: { type: "group", provider: state.provider, subject: "engineering" },
      role: "developer",
      revision: 7,
    });
  });
  it("transfers to a person and revokes an assignment through distinct operations", async () => {
    await cli("transfer", "--person", "successor");
    const transfer = requests.find((request) => request.method === "PUT");
    expect(transfer?.path).toBe(`/api/v1/apps/${appId}/owner`);
    expect(contract.appOwnershipTransfer.parse(JSON.parse(transfer?.body ?? "")).principal).toEqual(
      { type: "user", provider: state.provider, subject: "successor" },
    );
    await cli("revoke", assignmentId);
    expect(requests.at(-1)).toEqual({
      path: `/api/v1/apps/${appId}/roles/${assignmentId}`,
      method: "DELETE",
      body: '{"revision":7}',
    });
  });
  it("preserves conflicts without retrying and rejects preview writes", async () => {
    rejection = true;
    await expect(cli("grant", "--member", "local-member", "--role", "admin")).rejects.toThrow(
      "Permissions changed",
    );
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    requests.length = 0;
    rejection = false;
    inherited = true;
    await expect(cli("transfer", "--group", "operations")).rejects.toThrow(
      "Previews inherit roles",
    );
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });
  it.each([
    ["grant", "--group", "team", "--role", "owner"],
    ["transfer", "--person", "user", "--group", "team"],
    ["transfer"],
  ])("rejects ambiguous role changes: %s", async (...args) => {
    await expect(cli(...args)).rejects.toMatchObject({ code: 2 });
    expect(requests).toHaveLength(0);
  });
});
