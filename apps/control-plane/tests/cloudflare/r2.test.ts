import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformProxy } from "wrangler";
import type { CloudflareBindings } from "../../src/lib/server/cloudflare-config.ts";
import { createArtifactStorage } from "../../src/lib/server/artifact-storage.ts";
import { createR2Storage } from "../../src/lib/server/storage/r2.ts";

describe.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")("Native R2 artifact storage", () => {
  let directory: string;
  let platform: PlatformProxy<Pick<CloudflareBindings, "ARTIFACTS">>;
  let storage: ReturnType<typeof createArtifactStorage>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "widefleet-r2-"));
    const configPath = join(directory, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "widefleet-r2-test",
        compatibility_date: "2026-10-01",
        r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "artifacts" }],
      }),
    );
    const { getPlatformProxy } = await import("wrangler");
    platform = await getPlatformProxy<Pick<CloudflareBindings, "ARTIFACTS">>({
      configPath,
      persist: false,
      remoteBindings: false,
    });
    storage = createArtifactStorage(createR2Storage(platform.env.ARTIFACTS));
  });

  afterAll(async () => {
    await platform?.dispose();

    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("preserves immutable binary bytes during retries and competing writes", async () => {
    const key = "apps/immutable/assets/first";
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    expect((await storage.exists(key)).unwrap()).toBe(false);
    (await storage.put(key, bytes, "application/octet-stream")).unwrap();
    (await storage.put(key, Uint8Array.of(42), "text/plain")).unwrap();
    expect((await storage.get(key)).unwrap()).toEqual(bytes);
    expect((await storage.exists(key)).unwrap()).toBe(true);
    expect((await platform.env.ARTIFACTS.head(key))?.httpMetadata?.contentType).toBe(
      "application/octet-stream",
    );
    const competing = "apps/immutable/assets/race";

    const results = await Promise.all([
      storage.put(competing, Uint8Array.of(1), "text/plain"),
      storage.put(competing, Uint8Array.of(2), "text/plain"),
    ]);

    for (const result of results) result.unwrap();
    expect([Uint8Array.of(1), Uint8Array.of(2)]).toContainEqual(
      (await storage.get(competing)).unwrap(),
    );
    expect(await storage.get("missing")).toMatchObject({ error: { _tag: "StorageUnavailable" } });
  });

  it("lists all pages and removes only the selected app across deletion batches", async () => {
    const bucket = platform.env.ARTIFACTS;

    for (let offset = 0; offset < 1001; offset += 25) {
      await Promise.all(
        Array.from({ length: Math.min(25, 1001 - offset) }, (_, index) =>
          bucket.put(`apps/paginated/assets/${offset + index}`, "fixture"),
        ),
      );
    }

    await bucket.put("apps/paginated/artifacts/worker", "worker");
    await bucket.put("apps/paginated-other/assets/keep", "keep");
    const inventory = (await storage.assetInventory("paginated")).unwrap();
    expect(inventory.size).toBe(1001);
    expect(inventory.get("1000")).toBe(7);
    (await storage.removeApp("paginated")).unwrap();
    expect((await bucket.list({ prefix: "apps/paginated/" })).objects).toEqual([]);
    expect(await (await bucket.get("apps/paginated-other/assets/keep"))?.text()).toBe("keep");
  }, 30_000);
});
