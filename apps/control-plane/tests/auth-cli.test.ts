import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

const failedCommand = z.object({ code: z.number(), stdout: z.string(), stderr: z.string() });

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")("CLI authentication diagnostics", () => {
  let directory: string;
  let unavailableOrigin: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "widefleet-auth-cli-"));
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    unavailableOrigin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const cliFailure = async (token?: string) => {
    try {
      await execute(
        process.env["CLI_BINARY"] ??
          fileURLToPath(new URL("../../../target/debug/widefleet", import.meta.url)),
        ["--url", unavailableOrigin, "whoami"],
        {
          timeout: 10000,
          env: {
            ...process.env,
            CI: undefined,
            WIDEFLEET_TELEMETRY_DEBUG: "1",
            WIDEFLEET_TELEMETRY_DISABLED: "0",
            PLATFORM_USAGE_REPORTING: undefined,
            PLATFORM_CRASH_REPORTING: undefined,
            PLATFORM_ACCESS_TOKEN: token,
            PLATFORM_SESSION_FILE: undefined,
            XDG_STATE_HOME: directory,
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(directory, "missing-bus")}`,
            NO_PROXY: "127.0.0.1",
            no_proxy: "127.0.0.1",
          },
        },
      );
    } catch (error) {
      return failedCommand.parse(error);
    }

    throw new Error("Expected authentication to fail");
  };

  it.runIf(process.platform === "linux")(
    "explains an unavailable credential service and names the noninteractive alternative",
    async () => {
      const result = await cliFailure();
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Could not initialize the operating system credential store");
      expect(result.stderr).toContain("Secret Service");
      expect(result.stderr).toContain("PLATFORM_ACCESS_TOKEN");
      expect(result.stderr).not.toContain("No default store has been set");
    },
  );

  it("bypasses the credential store and prints transport causes before telemetry", async () => {
    const result = await cliFailure("synthetic-access-token-never-log");
    const diagnostic = result.stderr.split("[widefleet telemetry]")[0];

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[widefleet telemetry]");
    expect(diagnostic).toContain("HTTP request failed");
    expect(diagnostic).toContain("Caused by:");
    expect(diagnostic).toMatch(/connection refused/i);
    expect(result.stderr).not.toContain(unavailableOrigin);
    expect(result.stderr).not.toContain("synthetic-access-token-never-log");
    expect(result.stderr).not.toContain("Credential store failed");
  });
});
