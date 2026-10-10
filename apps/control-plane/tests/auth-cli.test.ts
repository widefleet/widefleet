import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
          fileURLToPath(
            new URL(
              `../../../target/debug/widefleet${process.platform === "win32" ? ".exe" : ""}`,
              import.meta.url,
            ),
          ),
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
    expect(diagnostic).toMatch(/connection refused|actively refused/i);
    expect(result.stderr).not.toContain(unavailableOrigin);
    expect(result.stderr).not.toContain("synthetic-access-token-never-log");
    expect(result.stderr).not.toContain("Credential store failed");
  });
});

describe.runIf(process.env["RUN_CLI_TESTS"] === "1" && process.platform !== "win32")(
  "CLI connection configuration with a local OAuth fixture",
  () => {
    let directory: string;
    let origin: string;
    let configFile: string;
    let sessionFile: string;
    let denyLogin = false;

    const requests: string[] = [];

    const server = createServer((request, response) => {
      request.resume();
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");

      switch (request.url) {
        case "/api/auth/device/code":
          response.end(
            JSON.stringify({
              device_code: "synthetic-device-code",
              user_code: "TEST-CODE",
              verification_uri: `${origin}/device`,
              expires_in: 60,
              interval: 1,
            }),
          );
          break;
        case "/api/auth/oauth2/token":
          if (denyLogin) response.writeHead(400).end(JSON.stringify({ error: "access_denied" }));
          else
            response.end(
              JSON.stringify({
                access_token: "synthetic-access-token-never-log",
                refresh_token: "synthetic-refresh-token-never-log",
                expires_in: 300,
                token_type: "Bearer",
              }),
            );
          break;
        case "/api/v1/me":
          response.end(JSON.stringify({ email: "employee@example.test" }));
          break;
        case "/api/auth/oauth2/revoke":
          response.end("{}");
          break;
        default:
          response.writeHead(404).end("{}");
      }
    });

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet-connection-"));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
    });

    beforeEach(() => {
      const id = crypto.randomUUID();
      configFile = join(directory, `${id}.json`);
      sessionFile = join(directory, id, "session.json");
      denyLogin = false;
      requests.length = 0;
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
          fileURLToPath(new URL("../../../target/debug/widefleet", import.meta.url)),
        args,
        {
          timeout: 10000,
          env: {
            ...process.env,
            PLATFORM_URL: undefined,
            PLATFORM_ACCESS_TOKEN: undefined,
            PLATFORM_CONFIG_FILE: configFile,
            PLATFORM_SESSION_FILE: sessionFile,
            XDG_STATE_HOME: join(directory, "state"),
            WIDEFLEET_TELEMETRY_DISABLED: "1",
            NO_PROXY: "127.0.0.1",
            no_proxy: "127.0.0.1",
          },
        },
      );

    it("remembers a successful login and uses the URL for API calls and logout", async () => {
      const login = await cli("--url", origin, "login");
      expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ platform_url: origin });
      expect(login.stdout + login.stderr).not.toContain("synthetic-access-token-never-log");
      expect(login.stdout + login.stderr).not.toContain("synthetic-refresh-token-never-log");
      expect(JSON.parse((await cli("whoami")).stdout)).toEqual({ email: "employee@example.test" });
      await cli("logout");
      expect(requests).toEqual([
        "/api/auth/device/code",
        "/api/auth/oauth2/token",
        "/api/v1/me",
        "/api/auth/oauth2/revoke",
      ]);
      expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ platform_url: origin });
    });

    it("keeps the previous URL when a new login is denied", async () => {
      await cli("config", "set-url", "https://previous.example.test");
      denyLogin = true;
      await expect(cli("--url", origin, "login")).rejects.toThrow("Device login was denied");
      expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
        platform_url: "https://previous.example.test",
      });
    });

    it("inspects, replaces and clears configuration without contacting an API", async () => {
      expect(JSON.parse((await cli("config")).stdout)).toMatchObject({ platform_url: null });
      await cli("config", "set-url", "https://platform.example.test:443/");
      expect(JSON.parse((await cli("config", "show")).stdout)).toMatchObject({
        platform_url: "https://platform.example.test",
        source: "user",
        config_file: configFile,
      });
      expect(JSON.parse((await cli("--url", origin, "config", "show")).stdout)).toMatchObject({
        platform_url: origin,
        source: "override",
      });
      await cli("config", "unset-url");
      expect(JSON.parse((await cli("config")).stdout)).toMatchObject({ platform_url: null });
      expect(requests).toEqual([]);
    });

    it("reports a broken configuration and allows an explicit override to bypass it", async () => {
      await writeFile(configFile, "{");
      await expect(cli("whoami")).rejects.toThrow("Invalid CLI configuration");
      expect(JSON.parse((await cli("--url", origin, "config")).stdout)).toMatchObject({
        platform_url: origin,
        source: "override",
      });
      expect(requests).toEqual([]);
    });

    it("does not change the selected URL when an update is invalid", async () => {
      await cli("config", "set-url", origin);
      await expect(cli("config", "set-url", "http://insecure.example.test")).rejects.toThrow(
        "Use an HTTPS platform origin",
      );
      expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ platform_url: origin });
      expect(requests).toEqual([]);
    });
  },
);
