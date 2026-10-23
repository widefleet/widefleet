import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Unstable_DevWorker } from "wrangler";

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")("Company discovery in workerd", () => {
  let directory: string;
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "widefleet-discovery-workerd-"));
    const config = join(directory, "wrangler.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "company-discovery-fixture",
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
      }),
    );
    const { unstable_dev } = await import("wrangler");
    worker = await unstable_dev(
      fileURLToPath(new URL("./platform-discovery.fixture.ts", import.meta.url)),
      {
        config,
        local: true,
        ip: "127.0.0.1",
        port: 0,
        inspectorPort: 0,
        logLevel: "error",
        experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
      },
    );
  }, 30_000);

  afterAll(async () => {
    await worker?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(["txt", "https", "absent"])(
    "resolves the %s result with the production HTTP transport",
    async (scenario) => {
      const response = await worker.fetch(`/?scenario=${scenario}`);
      const result = await response.json();
      expect(result).toMatchObject({
        platform_url:
          scenario === "absent" ? "https://app.widefleet.com" : "https://platform.example.test",
      });
      expect(response.ok).toBe(true);
    },
  );

  it.each(["redirect", "html", "unavailable", "server-error"])(
    "continues in Cloud for %s without following redirects",
    async (scenario) => {
      const response = await worker.fetch(`/?scenario=${scenario}`);
      expect(await response.json()).toMatchObject({
        platform_url: "https://app.widefleet.com",
        requests: ["https://example.test/.well-known/widefleet"],
      });
      expect(response.status).toBe(200);
    },
  );
});
