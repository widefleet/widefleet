import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApi } from "../src/lib/server/api.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createTestEnvironment } from "./environment.ts";
import { memoryStorage } from "./memory-storage.fixture.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

beforeAll(async () => {
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

const runtimeFor = async () => {
  const runtime = await createRuntime({
    configuration: environment.configuration,
    database: environment.database,
    settings: environment.settings,
    storage: createStorage(environment.configuration, memoryStorage()),
    reporting: environment.reporting,
    encryption: environment.encryption,
  })();

  vi.spyOn(runtime.identity, "authenticate").mockResolvedValue(
    Result.ok({
      ...environment.owner,
      role: "owner",
      admin: true,
      creator: true,
      application: environment.application,
    }),
  );

  return runtime;
};

it("deploys and rolls back a version only while the app has the secrets it requires", async () => {
  const runtime = await runtimeFor();

  const principal = (
    await runtime.identity.authenticate(new Request("http://localhost"), "platform:write")
  ).unwrap();

  const app = (
    await runtime.apps.create(
      principal,
      contract.createAppInput.parse({ slug: "required-secrets", displayName: "required-secrets" }),
    )
  ).unwrap();

  const publish = async (required_secrets?: string[]) => {
    const session = (await runtime.uploads.start(principal, app.id, {})).unwrap();

    return runtime.uploads.publish(
      principal,
      app.id,
      contract.workerMetadata.parse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        bindings: [],
        assets: { upload_session: session.id, binding: "ASSETS" },
        required_secrets,
      }),
      null,
      [
        {
          name: "worker.js",
          type: "esm",
          bytes: new TextEncoder().encode(
            'export default { fetch: () => new Response("Hello") };\n',
          ),
        },
      ],
      crypto.randomUUID(),
    );
  };

  const deployments = () =>
    environment.database.db.query.deployments.findMany({
      where: (deployments, { eq }) => eq(deployments.appId, app.id),
    });

  const set = async (name: string, value: string | null) =>
    (await runtime.appSecrets.set(principal, app.id, name, value)).unwrap();

  // As `wrangler deploy`, the error lists every missing secret.
  const rejected = await publish(["API_KEY", "API_SECRET"]);

  expect(rejected.isErr() && rejected.error).toMatchObject({ code: "BAD_REQUEST" });
  expect(rejected.isErr() && rejected.error.message).toContain(
    "The following required secrets have not been set: API_KEY, API_SECRET.",
  );
  expect(await deployments()).toEqual([]);

  await set("API_KEY", "key");

  const partial = await publish(["API_KEY", "API_SECRET"]);

  expect(partial.isErr() && partial.error.message).toContain("have not been set: API_SECRET.");

  await set("API_SECRET", "secret");

  const required = (await publish(["API_KEY", "API_SECRET"])).unwrap();

  // As on Cloudflare, a secret the deployed code requires can be deleted.
  // The code reports its missing setup until the secret is set again.
  expect((await set("API_SECRET", null)).deployment).toMatchObject({
    artifactId: required.artifactId,
  });
  expect((await publish()).isOk()).toBe(true);

  // A rollback deploys the version's own list.
  const rollback = () =>
    createApi(runtime)(
      new Request(`http://localhost/api/v1/apps/${app.id}/rollback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ artifactId: required.artifactId }),
      }),
    );

  const refused = await rollback();

  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("have not been set: API_SECRET.");

  await set("API_SECRET", "secret");

  const restored = await rollback();

  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(contract.deployment.parse(await restored.json()).artifactId).toBe(required.artifactId);
});
