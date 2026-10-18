import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { settingsInput } from "@platform/contracts";
import { companyLoginRevision } from "../src/lib/server/auth.ts";
import { createRuntime, createRequestRuntime } from "../src/lib/server/runtime-services.ts";
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

  it("shares a settings read within a request and refreshes after a settings command", async () => {
    const reads = vi.spyOn(environment.settings, "resolve");
    const request = createRequestRuntime(resolve);
    const [first, simultaneous] = await Promise.all([request(), request()]);
    expect(simultaneous).toBe(first);
    expect(await request()).toBe(first);
    expect(reads).toHaveBeenCalledTimes(1);

    const input = settingsInput.parse((await environment.settings.inspect()).settings);

    if (!input.identity) throw new Error("Expected the fixture's company login");
    input.identity.management.secret = { type: "value", value: "changed-within-request" };
    await first.settings.initialize(input);
    const [refreshed, simultaneousRefresh] = await Promise.all([request(), request()]);
    expect(simultaneousRefresh).toBe(refreshed);
    expect(refreshed.configuration.IDENTITY?.management.clientSecret).toBe(
      "changed-within-request",
    );
    expect(refreshed.auth).not.toBe(first.auth);
    expect(reads).toHaveBeenCalledTimes(2);

    await createRequestRuntime(resolve)();
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it("checks settings again on the next HTTP request even if the previous request was cached", async () => {
    const request = createRequestRuntime(resolve);
    await request();
    await environment.database.db.delete(installation).where(eq(installation.id, "widefleet"));
    await expect(createRequestRuntime(resolve)()).rejects.toThrow(
      "The installation has not been initialized",
    );
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
