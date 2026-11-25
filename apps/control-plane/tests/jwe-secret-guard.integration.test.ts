import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { apps, organizationSettings } from "../src/lib/server/schema.ts";
import { seedDeployment } from "./cloudflare-deployment.fixture.ts";
import { createTestEnvironment } from "./environment.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

const guard = async () =>
  environment.database.db.execute(
    sql.raw(
      await readFile(
        new URL("../migrations/0044_require_jwe_secrets.sql", import.meta.url),
        "utf8",
      ),
    ),
  );

// A value in the bare hexadecimal format that releases before the keyring wrote.
const earlierFormat = "04170b74ec840be7258e5c66a39a6a3455ee568a0ea14a8df2866f47bf919593";

beforeAll(async () => {
  // Creating the environment applies every migration, including the guard, to JWE data.
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

it("refuses to upgrade while a stored secret is not JWE", async () => {
  const database = environment.database.db;
  const entry = await seedDeployment(database, { bindings: [] });

  await expect(guard()).resolves.toBeDefined();

  for (const write of [
    () =>
      database
        .update(apps)
        .set({ secrets: { TOKEN: earlierFormat } })
        .where(eq(apps.id, entry.appId)),
    () =>
      database
        .update(organizationSettings)
        .set({ appClientSecret: earlierFormat })
        .where(eq(organizationSettings.organizationId, "widefleet")),
  ]) {
    await write();
    await expect(guard()).rejects.toThrow(
      /Run "node tools\/secret-encryption.ts reencrypt" on the previous release first/,
    );
    await database.update(apps).set({ secrets: {} }).where(eq(apps.id, entry.appId));
    await database
      .update(organizationSettings)
      .set({ appClientSecret: null })
      .where(eq(organizationSettings.organizationId, "widefleet"));
  }

  await expect(guard()).resolves.toBeDefined();
});
