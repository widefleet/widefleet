import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestEnvironment } from "./environment.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createAuthentication } from "../src/lib/server/auth.ts";
import type { Principal } from "../src/lib/server/identity.ts";
import type { ObservationEvent } from "../src/lib/server/observation.ts";
import { eq } from "drizzle-orm";
import { installation } from "../src/lib/server/schema.ts";
import { createSettingsService } from "../src/lib/server/settings.ts";
import { installationKeys } from "../src/lib/server/installation-files.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";

describe("Installation observation", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => {
    await environment?.reporting.close();
    await environment?.close();
  });

  const owner = (): Principal => ({
    ...environment.owner,
    role: "owner",
    admin: true,
    creator: true,
    application: { organizationId: "widefleet", admin: true },
  });

  it("passes the original runtime error to the observer independently of installation reporting", async () => {
    const exception = vi.fn();

    const runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      storage: createStorage(environment.configuration),
      reporting: environment.reporting,
      observation: { capture: () => {}, exception, close: async () => {} },
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
    })();

    const error = new TypeError("Cannot read deployment status", {
      cause: new Error("Connection refused"),
    });

    runtime.reporting.exception(error);
    expect(exception.mock.calls[0]?.[0]).toBe(error);
  });

  it("observes committed app creation once across create/resolve retries", async () => {
    const events: ObservationEvent[] = [];

    const capture = vi.fn((event: ObservationEvent) => {
      events.push(event);
    });

    const service = createAppService(
      environment.database.db,
      environment.configuration,
      undefined,
      {
        capture,
        close: async () => {},
      },
    );

    const first = (await service.resolve(owner(), "observed-app")).unwrap();
    expect((await service.resolve(owner(), "observed-app")).unwrap().id).toBe(first.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "app_created",
      id: first.id,
      userId: environment.owner.id,
      organizationId: "widefleet",
      properties: { app_id: first.id, preview: false },
    });
    expect(
      (
        await service.create(owner(), {
          slug: "observed-app",
          displayName: "Duplicate",
          parentId: null,
        })
      ).isErr(),
    ).toBe(true);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(environment.owner.email);
  });

  it.each(["sync", "async"])(
    "preserves successful application operations on %s observer failures",
    async (mode) => {
      const service = createAppService(
        environment.database.db,
        environment.configuration,
        undefined,
        {
          capture: () => {
            if (mode === "async") return Promise.reject(new Error("Observer unavailable"));
            throw new Error("Observer unavailable");
          },
          close: async () => {},
        },
      );

      expect((await service.resolve(owner(), `observation-failure-${mode}`)).isOk()).toBe(true);
    },
  );

  it("emits user creation and session creation from authentication hooks", async () => {
    const events: ObservationEvent[] = [];

    const auth = createAuthentication(environment.configuration, environment.database.db, {
      observation: {
        capture: (event) => {
          events.push(event);
        },
        close: async () => {},
      },
    });

    const { internalAdapter } = await auth.$context;

    const user = await internalAdapter.createUser(
      {
        email: "observation@example.test",
        name: "Observation",
        emailVerified: true,
      },
      { method: "email-otp" },
    );

    await internalAdapter.createSession(user.id);
    expect(events.map((event) => event.event)).toEqual(["user_created", "user_signed_in"]);
    expect(events.every((event) => event.userId === user.id)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(user.email);
  });

  it("observes interactive setup only after successful owner creation", async () => {
    const setup = await createTestEnvironment();
    const events: ObservationEvent[] = [];

    try {
      await setup.database.db
        .update(installation)
        .set({ ownerId: null })
        .where(eq(installation.id, "widefleet"));

      const settings = createSettingsService(
        { ...setup.configuration, LOGIN_CODE_DELIVERY: "console" },
        setup.database.db,
        (await installationKeys(setup.configuration)).encryption,
        () => null,
        false,
        {
          capture: (event) => {
            events.push(event);
          },
          close: async () => {},
        },
      );

      await expect(
        settings.createOwner({ name: "Duplicate", email: setup.owner.email }),
      ).rejects.toThrow();
      expect(events).toEqual([]);

      const created = await settings.createOwner({
        name: "Observed owner",
        email: "setup-observer@example.test",
      });

      expect(events).toEqual([{ event: "user_created", id: created.id, userId: created.id }]);
      await expect(
        settings.createOwner({ name: "Retry", email: "setup-observer@example.test" }),
      ).rejects.toThrow();
      expect(events).toHaveLength(1);
    } finally {
      await setup.close();
    }
  });
});
