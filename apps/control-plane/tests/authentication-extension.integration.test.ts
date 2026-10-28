import { afterAll, beforeAll, expect, it } from "vitest";
import { createAuthEndpoint } from "better-auth/api";
import { createAuthentication } from "../src/lib/server/auth.ts";
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
