import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { organizationSettings } from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

const guard = async () =>
  environment.database.db.execute(
    sql.raw(
      await readFile(
        new URL("../migrations/0046_require_converted_sso.sql", import.meta.url),
        "utf8",
      ),
    ),
  );

beforeAll(async () => {
  // Creating the environment applies every migration, including the guard, to converted data.
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

it("refuses to upgrade while an organization still has the SSO configuration of earlier releases", async () => {
  const database = environment.database.db;
  const organizationId = "widefleet";

  const [current] = await database
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId));

  if (!current) throw new Error("The test environment has no organization settings");

  const updateSettings = async (values: Partial<typeof organizationSettings.$inferInsert>) => {
    await database
      .update(organizationSettings)
      .set(values)
      .where(eq(organizationSettings.organizationId, organizationId));
  };

  await expect(guard()).resolves.toBeDefined();

  try {
    // Earlier releases kept the key even when no company SSO was configured.
    for (const identity of [
      { management: { clientId: "client", secret: { ciphertext: "ciphertext" } } },
      null,
    ]) {
      await updateSettings({ settings: { externallyManaged: false, identity } });
      await expect(guard()).rejects.toThrow(
        /Start the previous release once so it converts the earlier SSO configuration, then upgrade/,
      );
    }
  } finally {
    await updateSettings({ settings: current.settings });
  }

  await expect(guard()).resolves.toBeDefined();
});
