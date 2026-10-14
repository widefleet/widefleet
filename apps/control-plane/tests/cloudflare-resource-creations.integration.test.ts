import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { apps, cloudflareResourceCreations } from "../src/lib/server/schema.ts";
import { CloudflareApiError } from "../src/lib/server/cloudflare-provisioning.ts";
import {
  CloudflareResourceCreationPending,
  createCloudflareResourceCreator,
} from "../src/lib/server/cloudflare-resource-creations.ts";

describe("Durable app resource creation", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  beforeEach(async () => {
    await environment.database.db.delete(apps);
  });
  afterAll(async () => {
    await environment.close();
  });

  it.each(["d1", "r2", "kv", "queue"] as const)(
    "confirms a lost %s creation response without a duplicate CREATE",
    async (kind) => {
      const entry = await seedDeployment(environment.database.db);
      const ensure = createCloudflareResourceCreator(environment.database.db, "fixture-account");
      let present = false;
      let calls = 0;
      const read = async () => (present ? "resource-id" : null);

      const create = async () => {
        calls++;
        present = true;
        throw new Error("Lost CREATE acknowledgement");
      };

      await expect(ensure(entry.appId, kind, "resource", read, create)).rejects.toBeInstanceOf(
        CloudflareResourceCreationPending,
      );
      expect(await environment.database.db.select().from(cloudflareResourceCreations)).toHaveLength(
        1,
      );
      expect(await ensure(entry.appId, kind, "resource", read, create)).toBe("resource-id");
      expect(calls).toBe(1);
      expect(await environment.database.db.select().from(cloudflareResourceCreations)).toHaveLength(
        0,
      );
    },
  );

  it("never resends an unresolved CREATE and prevents new creation after deletion is admitted", async () => {
    const entry = await seedDeployment(environment.database.db);
    const ensure = createCloudflareResourceCreator(environment.database.db, "fixture-account");
    let calls = 0;

    const create = async () => {
      calls++;
      throw new Error("Remote request may still be running");
    };

    for (let attempt = 0; attempt < 3; attempt++)
      await expect(
        ensure(entry.appId, "d1", "resource", async () => null, create),
      ).rejects.toBeInstanceOf(CloudflareResourceCreationPending);
    expect(calls).toBe(1);
    await environment.database.db
      .update(apps)
      .set({ state: "deleting" })
      .where(eq(apps.id, entry.appId));
    await expect(
      ensure(entry.appId, "queue", "new-resource", async () => null, create),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(1);
    expect(await environment.database.db.select().from(cloudflareResourceCreations)).toHaveLength(
      1,
    );
  });

  it("clears explicit API rejections so the next request can create normally", async () => {
    const entry = await seedDeployment(environment.database.db);
    const ensure = createCloudflareResourceCreator(environment.database.db, "fixture-account");
    await expect(
      ensure(
        entry.appId,
        "r2",
        "resource",
        async () => null,
        async () => {
          throw new CloudflareApiError(403);
        },
      ),
    ).rejects.toBeInstanceOf(CloudflareApiError);
    expect(await environment.database.db.select().from(cloudflareResourceCreations)).toHaveLength(
      0,
    );
    expect(
      await ensure(
        entry.appId,
        "r2",
        "resource",
        async () => null,
        async () => "resource-id",
      ),
    ).toBe("resource-id");
  });
});
