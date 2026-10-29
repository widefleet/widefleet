import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import * as analytics from "../src/lib/server/analytics.ts";
import { initializeRuntime } from "../src/lib/server/runtime-initialization.ts";
import { createTestEnvironment } from "./environment.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

beforeAll(async () => {
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

it("reports idle database connection errors through the runtime observer", async () => {
  const exception = vi.fn();

  const observer = vi.spyOn(analytics, "createProductAnalytics").mockReturnValue({
    capture: () => {},
    exception,
    close: async () => {},
  });

  const runtime = await initializeRuntime(
    environment.configuration,
    fileURLToPath(new URL("../migrations", import.meta.url)),
  );

  try {
    const failure = new Error("Idle PostgreSQL connection disconnected");
    runtime.database.db.$client.emit("error", failure);
    expect(exception).toHaveBeenCalledExactlyOnceWith(failure);
  } finally {
    await runtime.database.close();
    observer.mockRestore();
  }
});

it("reports startup failures before the Node server has a runtime", async () => {
  const eventsPath = join(
    environment.configuration.PLATFORM_STATE_DIRECTORY,
    "startup-events.jsonl",
  );

  await expect(
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("./analytics-preload.fixture.ts", import.meta.url)),
        "build/index.js",
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: {
          ...process.env,
          ...environment.environment,
          DATABASE_URL: "invalid-url",
          HOST: "127.0.0.1",
          PORT: "0",
          POSTHOG_PROJECT_TOKEN: "phc_synthetic",
          POSTHOG_ORIGIN: environment.configuration.PLATFORM_URL,
          POSTHOG_SCOPE: "installation",
          TEST_ANALYTICS_OUTPUT: eventsPath,
        },
        timeout: 20000,
      },
    ),
  ).rejects.toMatchObject({ code: 1 });

  const events = (await readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) =>
      z.object({ event: z.string(), distinct_id: z.string() }).parse(JSON.parse(line)),
    );

  expect(events).toEqual([{ event: "$exception", distinct_id: "installation:control-plane" }]);
}, 25000);
