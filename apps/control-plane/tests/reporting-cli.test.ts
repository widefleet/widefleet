import { once, EventEmitter } from "node:events";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

const binary =
  process.env["CLI_BINARY"] ??
  `target/debug/widefleet${process.platform === "win32" ? ".exe" : ""}`;

const status = z.object({
  id: z.uuid(),
  preferences: z.object({ usage: z.boolean(), crashes: z.boolean() }),
});

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")(
  "CLI telemetry with local state and debug output",
  () => {
    let directory: string;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet-reporting-cli-"));
    });

    afterAll(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    const environment = () => ({
      ...process.env,
      XDG_STATE_HOME: directory,
      CI: undefined,
      PLATFORM_URL: undefined,
      WIDEFLEET_TELEMETRY_DEBUG: "1",
      WIDEFLEET_TELEMETRY_DISABLED: "0",
      PLATFORM_USAGE_REPORTING: undefined,
      PLATFORM_CRASH_REPORTING: undefined,
    });

    it("persists identity and controls categories without a platform login", async () => {
      const initial = await execute(binary, ["telemetry", "status"], {
        env: environment(),
      });

      const first = status.parse(JSON.parse(initial.stdout));

      expect(first.preferences).toEqual({ usage: true, crashes: true });
      expect(initial.stderr).not.toContain("[widefleet telemetry]");
      await execute(binary, ["telemetry", "disable", "--crashes"], {
        env: environment(),
      });

      const changed = await execute(binary, ["telemetry", "status"], {
        env: environment(),
      });

      expect(status.parse(JSON.parse(changed.stdout))).toEqual({
        id: first.id,
        preferences: { usage: true, crashes: false },
      });
      expect(
        status.parse(
          JSON.parse(await readFile(join(directory, "widefleet/telemetry.json"), "utf8")),
        ).preferences,
      ).toEqual({ usage: true, crashes: false });
    });

    it.each(["apps", "login"])(
      "prints %s errors before telemetry and honors opt-out",
      async (command) => {
        await execute(binary, ["telemetry", "enable"], { env: environment() });

        const failure = await execute(binary, [command], {
          env: environment(),
        }).then(
          () => null,
          (cause: unknown) => z.object({ code: z.number(), stderr: z.string() }).parse(cause),
        );

        expect(failure?.code).toBe(1);
        expect(failure?.stderr).toContain('"event":"cli_command_completed"');
        expect(failure?.stderr).toContain('"event":"$exception"');
        expect(failure?.stderr).not.toContain('"message":');
        expect(failure?.stderr.split("[widefleet telemetry]")[0]).toBe(
          "Set --url or PLATFORM_URL to the management origin\n",
        );

        const line = failure?.stderr
          .split("\n")
          .find(
            (entry) =>
              entry.startsWith("[widefleet telemetry] ") && entry.includes('"event":"$exception"'),
          );

        const captured = z
          .object({
            properties: z.object({
              $exception_list: z.array(
                z.object({
                  stacktrace: z.object({
                    frames: z.array(
                      z.object({
                        platform: z.literal("custom"),
                        lang: z.literal("rust"),
                        function: z.string(),
                        filename: z.string(),
                      }),
                    ),
                  }),
                }),
              ),
            }),
          })
          .parse(JSON.parse(z.string().parse(line).slice("[widefleet telemetry] ".length)));

        expect(captured.properties.$exception_list[0]?.stacktrace.frames[0]?.filename).toBe(
          "crates/platform-cli/src/main.rs",
        );

        await execute(binary, ["telemetry", "disable"], { env: environment() });

        const disabled = await execute(binary, [command], {
          env: environment(),
        }).then(
          () => null,
          (cause: unknown) => z.object({ code: z.number(), stderr: z.string() }).parse(cause),
        );

        expect(disabled?.code).toBe(1);
        expect(disabled?.stderr).not.toContain("[widefleet telemetry]");
      },
    );
    it("preserves both opt-outs when preference updates run concurrently", async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await execute(binary, ["telemetry", "enable"], { env: environment() });
        await Promise.all([
          execute(binary, ["telemetry", "disable", "--usage"], {
            env: environment(),
          }),
          execute(binary, ["telemetry", "disable", "--crashes"], {
            env: environment(),
          }),
        ]);

        const saved = status.parse(
          JSON.parse(await readFile(join(directory, "widefleet/telemetry.json"), "utf8")),
        );

        expect(saved.preferences).toEqual({ usage: false, crashes: false });
      }
    });

    it.each(["disabled", "missing"])(
      "honors %s preferences while another command waits for its API",
      async (mode) => {
        await execute(binary, ["telemetry", "enable"], { env: environment() });
        const gate = new EventEmitter();

        const server = createServer((request, response) => {
          request.resume();
          gate.once("respond", () => {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "synthetic API failure" }));
          });
        });

        server.listen(0, "127.0.0.1");
        await once(server, "listening");

        try {
          const address = z.object({ port: z.number() }).parse(server.address());
          const received = once(server, "request");

          const completed = execute(
            binary,
            ["--url", `http://127.0.0.1:${address.port}`, "whoami"],
            {
              env: { ...environment(), PLATFORM_ACCESS_TOKEN: "synthetic-telemetry-test-token" },
              timeout: 10_000,
            },
          ).then(
            () => null,
            (cause: unknown) => z.object({ code: z.number(), stderr: z.string() }).parse(cause),
          );

          await received;

          if (mode === "disabled")
            await execute(binary, ["telemetry", "disable"], {
              env: environment(),
            });
          else await rm(join(directory, "widefleet/telemetry.json"));
          gate.emit("respond");
          const result = await completed;
          expect(result?.code).toBe(1);
          expect(result?.stderr).not.toContain("[widefleet telemetry]");
        } finally {
          gate.emit("respond");
          const closed = once(server, "close");
          server.close();
          await closed;
        }
      },
    );
    it("reads saved status without creating a lock in read-only storage", async () => {
      await execute(binary, ["telemetry", "disable"], { env: environment() });
      const stateDirectory = join(directory, "widefleet");
      const lock = join(stateDirectory, "telemetry.lock");
      await rm(lock);
      await chmod(stateDirectory, 0o500);

      try {
        const saved = await execute(binary, ["telemetry", "status"], {
          env: environment(),
        });

        expect(status.parse(JSON.parse(saved.stdout)).preferences).toEqual({
          usage: false,
          crashes: false,
        });
        await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await chmod(stateDirectory, 0o700);
      }
    });
  },
);
