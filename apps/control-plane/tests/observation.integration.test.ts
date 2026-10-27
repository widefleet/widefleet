import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestEnvironment } from "./environment.ts";
import { createAppService } from "../src/lib/server/apps.ts";
import { createAuthentication } from "../src/lib/server/auth.ts";
import type { Principal } from "../src/lib/server/identity.ts";
import type { ObservationEvent } from "../src/lib/server/observation.ts";

describe("Installation observation", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => {
    await environment?.close();
  });

  const owner = (): Principal => ({
    ...environment.owner,
    role: "owner",
    admin: true,
    creator: true,
    application: { organizationId: "widefleet", admin: true },
  });

  it("observes committed app creation once across create/resolve retries", async () => {
    const events: ObservationEvent[] = [];
    const capture = vi.fn((event: ObservationEvent) => events.push(event));

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

  it("preserves successful application operations when an observer throws", async () => {
    const service = createAppService(
      environment.database.db,
      environment.configuration,
      undefined,
      {
        capture: () => {
          throw new Error("Observer unavailable");
        },
        close: async () => {},
      },
    );

    expect((await service.resolve(owner(), "observation-failure")).isOk()).toBe(true);
  });

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
});
