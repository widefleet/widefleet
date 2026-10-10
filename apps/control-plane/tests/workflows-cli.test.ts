import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")("Workflow restart CLI", () => {
  const appId = "00000000-0000-4000-8000-000000000001";

  const requests: {
    method: string;
    path: string;
    authorization: string;
    key: string;
    body: string;
  }[] = [];

  let origin: string;
  let operationId: string;
  let failed = false;

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body,
        authorization: request.headers.authorization ?? "",
        key: z.string().optional().parse(request.headers["idempotency-key"]) ?? "",
      });
      response.setHeader("content-type", "application/json");

      if (request.method === "POST" && request.url === `/api/v1/apps/${appId}/workflows`) {
        operationId = z.uuid().parse(request.headers["idempotency-key"]);
        response.end(
          JSON.stringify({ id: operationId, state: "queued", message: null, result: null }),
        );
      } else if (request.url === `/api/v1/apps/${appId}/workflows/operations/${operationId}`) {
        response.end(
          JSON.stringify({
            id: operationId,
            state: failed ? "failed" : "succeeded",
            message: failed ? "Step not found in workflow history" : null,
            result: null,
          }),
        );
      } else response.writeHead(404).end();
    });
  });

  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
  });
  beforeEach(() => {
    requests.length = 0;
    failed = false;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
      ["workflows", "restart", "example", "run-1", "--app", appId, ...args],
      {
        timeout: 10000,
        env: {
          ...process.env,
          PLATFORM_URL: origin,
          PLATFORM_ACCESS_TOKEN: "synthetic-workflow-token",
          WIDEFLEET_TELEMETRY_DISABLED: "1",
        },
      },
    );

  it("submits the selected name, occurrence and type and waits for confirmation", async () => {
    const result = await cli(
      "--from-step-name",
      "approval",
      "--from-step-count",
      "2",
      "--from-step-type",
      "waitForEvent",
    );

    expect(JSON.parse(result.stdout)).toMatchObject({ state: "succeeded" });
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      request: {
        action: "restart",
        workflow: "example",
        id: "run-1",
        from: { name: "approval", count: 2, type: "waitForEvent" },
      },
    });
    expect(requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
    expect(
      requests.every(({ authorization }) => authorization === "Bearer synthetic-workflow-token"),
    ).toBe(true);
    expect(z.uuid().safeParse(requests[0]?.key).success).toBe(true);
  });

  it.each(["aggregate", ""])("accepts the step name %j with native defaults", async (name) => {
    const result = await cli("--from-step-name", name, "--no-wait");
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "queued" });
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      request: { action: "restart", workflow: "example", id: "run-1", from: { name } },
    });
    expect(requests).toHaveLength(1);
  });

  it("preserves restart from the beginning when no target is supplied", async () => {
    await cli("--no-wait");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      request: { action: "restart", workflow: "example", id: "run-1" },
    });
  });

  it.each([
    ["--from-step-count", "2"],
    ["--from-step-type", "sleep"],
    ["--from-step-name", "aggregate", "--from-step-count", "0"],
    ["--from-step-name", "aggregate", "--from-step-count", "1.5"],
    ["--from-step-name", "aggregate", "--from-step-type", "sleepUntil"],
  ])("rejects invalid selectors before sending a request: %j", async (...args) => {
    await expect(cli(...args)).rejects.toMatchObject({ code: 2 });
    expect(requests).toHaveLength(0);
  });

  it("reports a failed restart without submitting it again", async () => {
    failed = true;
    await expect(cli("--from-step-name", "missing")).rejects.toThrow(
      "Step not found in workflow history",
    );
    expect(requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
  });
});
