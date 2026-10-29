import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { createApi } from "../src/lib/server/api.ts";
import { deploymentCommand } from "../src/lib/server/deployment-execution.ts";
import { createRuntime, type Runtime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createTestEnvironment } from "./environment.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let runtime: Runtime;

beforeAll(async () => {
  environment = await createTestEnvironment();
  runtime = await createRuntime({
    configuration: environment.configuration,
    database: environment.database,
    settings: environment.settings,
    storage: createStorage(environment.configuration, memoryStorage()),
    reporting: environment.reporting,
    encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
  })();
});

beforeEach(() => {
  vi.spyOn(runtime.identity, "authenticate").mockResolvedValue(
    Result.ok({
      ...environment.owner,
      role: "owner",
      admin: true,
      creator: true,
      application: environment.application,
    }),
  );
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => environment?.close());

const request = (path: string, body: string) =>
  createApi(runtime)(
    new Request(`http://localhost/api/v1${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    }),
  );

it.each(["backend", "browser"])(
  "passes %s network changes through hosted command validation",
  async (target) => {
    const change = runtime.network.change;

    vi.spyOn(runtime.network, "change").mockImplementation((actor, appId, input) => {
      deploymentCommand.parse({
        kind: "network",
        id: crypto.randomUUID(),
        appId,
        actor,
        input,
        createdAt: new Date().toISOString(),
      });

      return change(actor, appId, input);
    });

    const actor = (
      await runtime.identity.authenticate(new Request("http://localhost"), "platform:write")
    ).unwrap();

    const app = (
      await runtime.apps.create(
        actor,
        contract.createAppInput.parse({
          slug: `network-${target}`,
          displayName: "Network fixture",
        }),
      )
    ).unwrap();

    for (const action of ["allow", "deny"]) {
      const response = await request(
        `/apps/${app.id}/network`,
        JSON.stringify({
          target,
          action,
          origins: ["https://api.example.test"],
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        state: "saved",
        policy: { [target]: action === "allow" ? ["https://api.example.test"] : [] },
      });
    }
  },
);

it("passes access changes through hosted command validation", async () => {
  const change = runtime.appAccess.change;

  vi.spyOn(runtime.appAccess, "change").mockImplementation((actor, appId, input) => {
    deploymentCommand.parse({
      kind: "access",
      id: crypto.randomUUID(),
      appId,
      actor,
      input,
      createdAt: new Date().toISOString(),
    });

    return change(actor, appId, input);
  });

  const actor = (
    await runtime.identity.authenticate(new Request("http://localhost"), "platform:write")
  ).unwrap();

  const app = (
    await runtime.apps.create(
      actor,
      contract.createAppInput.parse({ slug: "access-change", displayName: "Access fixture" }),
    )
  ).unwrap();

  const initial = (await runtime.appAccess.read(actor, app.id)).unwrap();

  const response = await request(
    `/apps/${app.id}/access`,
    JSON.stringify({
      revision: initial.revision,
      groups: ["engineering"],
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: "saved",
    revision: initial.revision + 1,
    groups: ["engineering"],
  });
});
