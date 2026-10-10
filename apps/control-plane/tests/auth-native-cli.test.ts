import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

describe.runIf(process.env["RUN_CLI_NATIVE_AUTH"] === "1")(
  "CLI with the native credential store",
  () => {
    let directory: string;
    let origin: string;
    let refreshes = 0;
    let revoked = "";
    const accessToken = `synthetic-${"a".repeat(1024)}`;

    const binary = resolve(
      process.env["CLI_BINARY"] ??
        `target/debug/widefleet${process.platform === "win32" ? ".exe" : ""}`,
    );

    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        const form = new URLSearchParams(body);

        if (request.url === "/api/auth/device/code") {
          response.end(
            JSON.stringify({
              device_code: "synthetic-device",
              user_code: "TEST-ONLY",
              verification_uri: `${origin}/device`,
              expires_in: 30,
              interval: 1,
            }),
          );
        } else if (request.url === "/api/auth/oauth2/token") {
          const refresh = form.get("grant_type") === "refresh_token";

          if (refresh) {
            if (form.get("refresh_token") !== "synthetic-refresh") {
              response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));

              return;
            }

            refreshes += 1;
          }

          response.end(
            JSON.stringify({
              access_token: accessToken,
              refresh_token: refresh ? "synthetic-rotated" : "synthetic-refresh",
              expires_in: refresh ? 3600 : 1,
              token_type: "Bearer",
            }),
          );
        } else if (request.url === "/api/auth/oauth2/revoke") {
          revoked = form.get("token") ?? "";
          response.end("{}");
        } else if (
          request.url === "/api/v1/me" &&
          request.headers.authorization === `Bearer ${accessToken}`
        ) {
          response.end(JSON.stringify({ id: "synthetic-user" }));
        } else {
          response.writeHead(401).end("{}");
        }
      });
    });

    const cli = (...args: string[]) =>
      execute(binary, args, {
        timeout: 15_000,
        env: {
          ...process.env,
          XDG_STATE_HOME: directory,
          PLATFORM_URL: undefined,
          PLATFORM_CONFIG_FILE: join(directory, "config.json"),
          PLATFORM_ACCESS_TOKEN: undefined,
          PLATFORM_SESSION_FILE: undefined,
          WIDEFLEET_TELEMETRY_DISABLED: "1",
          NO_PROXY: "127.0.0.1",
          no_proxy: "127.0.0.1",
        },
      });

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet native auth "));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
    });

    afterAll(async () => {
      // The random loopback origin isolates this entry from real saved logins.
      await cli("logout").catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    });

    it("persists login, serializes refresh across processes, and removes the credential on logout", async () => {
      expect((await cli("--url", origin, "login")).stdout).toContain(
        "operating system's credential store",
      );
      expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8"))).toEqual({
        platform_url: origin,
      });
      const results = await Promise.all([cli("whoami"), cli("whoami"), cli("whoami")]);

      for (const result of results) {
        expect(JSON.parse(result.stdout)).toEqual({ id: "synthetic-user" });
        expect(result.stderr).not.toContain(accessToken);
      }

      expect(refreshes).toBe(1);
      await cli("logout");
      expect(revoked).toBe("synthetic-rotated");

      const failure = await cli("whoami").then(
        () => null,
        (cause: unknown) => z.object({ code: z.number(), stderr: z.string() }).parse(cause),
      );

      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain("Run widefleet login first");
    }, 30_000);

    it.runIf(process.platform === "win32")(
      "explains that session files require Unix permissions",
      async () => {
        const failure = await cli(
          "--url",
          origin,
          "--session-file",
          join(directory, "session.json"),
          "login",
        ).then(
          () => null,
          (cause: unknown) => z.object({ code: z.number(), stderr: z.string() }).parse(cause),
        );

        expect(failure?.code).toBe(1);
        expect(failure?.stderr).toContain("Session files require Unix file permissions");
        expect(failure?.stderr).toContain("PLATFORM_ACCESS_TOKEN");
      },
    );
  },
);
