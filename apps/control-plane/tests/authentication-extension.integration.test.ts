import { afterAll, beforeAll, expect, it } from "vitest";
import { createAuthEndpoint } from "better-auth/api";
import { eq } from "drizzle-orm";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { session } from "../src/lib/server/auth-schema.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createTestEnvironment } from "./environment.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

beforeAll(async () => {
  environment = await createTestEnvironment();
});

afterAll(async () => {
  await environment.close();
});

it("composes installation plugins and checks current user admission without changing the default", async () => {
  const denied = new Set<string>();

  const authentication = {
    plugins: [
      {
        id: "fixture-extension",
        endpoints: {
          extensionStatus: createAuthEndpoint("/extension-status", { method: "GET" }, async (ctx) =>
            ctx.json({ active: true }),
          ),
        },
      },
    ],
    allowUser: async (id: string) => !denied.has(id),
  };

  const auth = createAuthentication(environment.configuration, environment.database.db, {
    authentication,
  });

  const response = await auth.handler(
    new Request(`${environment.configuration.PLATFORM_URL}/api/auth/extension-status`),
  );

  expect(await response.json()).toEqual({ active: true });

  const login = await environment.users.login({ userId: environment.owner.id });

  const request = new Request(environment.configuration.PLATFORM_URL, { headers: login.headers });

  const identity = createIdentityService(
    auth,
    environment.database.db,
    environment.configuration,
    undefined,
    authentication.allowUser,
  );

  expect((await identity.authenticateUser(request, "platform:read")).isOk()).toBe(true);

  denied.add(environment.owner.id);

  expect((await identity.authenticateUser(request, "platform:read")).isErr()).toBe(true);

  const standard = createIdentityService(
    environment.auth,
    environment.database.db,
    environment.configuration,
  );

  expect((await standard.authenticateUser(request, "platform:read")).isOk()).toBe(true);
});

it("blocks direct account access and new sessions while still allowing sign-out", async () => {
  let allowed = true;

  const auth = createAuthentication(environment.configuration, environment.database.db, {
    authentication: { plugins: [], allowUser: async () => allowed },
  });

  const login = await environment.users.login({ userId: environment.owner.id });

  const headers = new Headers(login.headers);

  headers.set("origin", environment.configuration.PLATFORM_URL);
  headers.set("content-type", "application/json");

  const request = (path: string, body?: { name?: string }) => {
    const init: RequestInit = { method: body ? "POST" : "GET", headers };

    if (body) init.body = JSON.stringify(body);

    return auth.handler(
      new Request(`${environment.configuration.PLATFORM_URL}/api/auth${path}`, init),
    );
  };

  expect((await request("/get-session")).status).toBe(200);
  expect((await request("/list-sessions")).status).toBe(200);
  expect((await request("/update-user", { name: "Allowed name" })).status).toBe(200);
  const context = await auth.$context;

  expect(await context.internalAdapter.createSession(environment.owner.id)).toBeTruthy();

  allowed = false;

  for (const path of ["/get-session", "/list-sessions", "/list-accounts", "/token"])
    expect((await request(path)).status).toBe(403);

  expect((await request("/update-user", { name: "Blocked name" })).status).toBe(403);
  await expect(context.internalAdapter.createSession(environment.owner.id)).rejects.toThrow(
    "This account is unavailable",
  );
  expect((await context.internalAdapter.findUserById(environment.owner.id))?.name).toBe(
    "Allowed name",
  );
  expect((await request("/sign-out", {})).status).toBe(200);
  allowed = true;
  expect(await (await request("/get-session")).json()).toBeNull();
});

it.each([false, true])(
  "preserves session renewal cookies with admission enabled: %s",
  async (enabled) => {
    const auth = enabled
      ? createAuthentication(environment.configuration, environment.database.db, {
          authentication: { plugins: [], allowUser: async () => true },
        })
      : environment.auth;

    const login = await environment.users.login({ userId: environment.owner.id });

    const current = await auth.api.getSession({ headers: login.headers });

    if (!current) throw new Error("Expected owner session");
    const lifetime = 7 * 24 * 60 * 60;

    await environment.database.db
      .update(session)
      .set({
        expiresAt: new Date(Date.now() + (lifetime - 25 * 60 * 60) * 1000),
      })
      .where(eq(session.id, current.session.id));

    const renewed = await auth.api.getSession({ headers: login.headers, returnHeaders: true });

    expect(renewed.response?.session.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + (lifetime - 10) * 1000,
    );
    expect(renewed.headers.get("set-cookie")).toMatch(/Max-Age=604800/i);
  },
);
