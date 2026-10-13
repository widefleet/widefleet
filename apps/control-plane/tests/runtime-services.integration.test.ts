import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { settingsInput } from "@platform/contracts";
import { companyLoginRevision } from "../src/lib/server/auth.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { installation } from "../src/lib/server/schema.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createTestEnvironment } from "./environment.ts";

describe("Control-plane runtime settings", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let resolve: ReturnType<typeof createRuntime>;

  beforeEach(async () => {
    environment = await createTestEnvironment();
    resolve = createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      storage: createStorage(environment.configuration),
      reporting: environment.reporting,
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
    });
  });

  afterEach(async () => {
    await environment.reporting.close();
    await environment.close();
  });

  it("refreshes authentication after credential rotation without replacing application services", async () => {
    const first = await resolve();
    await first.auth.$context;
    expect(await resolve()).toBe(first);

    const input = settingsInput.parse((await environment.settings.inspect()).settings);

    if (!input.identity) throw new Error("Expected the fixture's company login");
    input.identity.management.secret = { type: "value", value: "rotated-fixture-secret" };
    await environment.settings.initialize(input);

    const rotated = await resolve();
    await rotated.auth.$context;
    expect(rotated.configuration.IDENTITY?.management.clientSecret).toBe("rotated-fixture-secret");
    expect(companyLoginRevision(rotated.configuration)).not.toBe(
      companyLoginRevision(first.configuration),
    );
    expect(rotated.auth).not.toBe(first.auth);
    expect(rotated.identity).not.toBe(first.identity);
    expect(rotated.directory).not.toBe(first.directory);
    expect(rotated.apps).toBe(first.apps);
    expect(rotated.jobs).toBe(first.jobs);
    expect(rotated.storage).toBe(first.storage);
    expect(rotated.reporting).toBe(first.reporting);
    expect(first.configuration.IDENTITY?.management.clientSecret).toBe("local-tests-only");
    expect(await resolve()).toBe(rotated);
  });

  it("disables password sign-in on the next resolution after setup closes", async () => {
    const first = await resolve();
    const body = { email: environment.owner.email, password: "local-test-password-only" };
    expect((await first.auth.api.signInEmail({ body })).user.id).toBe(environment.owner.id);

    await environment.database.db
      .update(installation)
      .set({ localPasswordEnabled: false })
      .where(eq(installation.id, "widefleet"));

    const configured = await resolve();
    expect(configured.configuration.LOCAL_PASSWORD_ENABLED).toBe(false);
    await expect(configured.auth.api.signInEmail({ body })).rejects.toMatchObject({
      body: { code: "EMAIL_PASSWORD_DISABLED" },
    });
    expect(configured.apps).toBe(first.apps);
  });

  it("propagates a settings failure instead of serving a cached authentication configuration", async () => {
    const current = await resolve();
    await current.auth.$context;
    await environment.database.db.delete(installation).where(eq(installation.id, "widefleet"));

    await expect(resolve()).rejects.toThrow("The installation has not been initialized");
  });
});
