import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { Result } from "better-result";
import { createTestEnvironment } from "./environment.ts";
import { createRuntime, type Runtime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { createApi } from "../src/lib/server/api.ts";
import { AuthenticationFailed } from "../src/lib/server/identity.ts";
import { DatabaseUnavailable, StorageUnavailable } from "../src/lib/server/errors.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let runtime: Runtime;

const exception = vi.fn();

beforeAll(async () => {
  environment = await createTestEnvironment();
  runtime = await createRuntime({
    configuration: environment.configuration,
    database: environment.database,
    settings: environment.settings,
    storage: createStorage(environment.configuration),
    reporting: environment.reporting,
    observation: { capture: () => {}, exception, close: async () => {} },
    encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
  })();
});

beforeEach(() => {
  exception.mockClear();
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => environment?.close());

it.each(["GET", "PUT"])("reports database errors once for %s API requests", async (method) => {
  const original = new Error("Database disconnected");
  const error = new DatabaseUnavailable({ message: "Identity unavailable", cause: original });
  vi.spyOn(runtime.identity, "authenticate").mockResolvedValue(Result.err(error));
  const path = method === "PUT" ? `/apps/${crypto.randomUUID()}/worker` : "/apps";

  const response = await createApi(runtime)(
    new Request(`http://localhost/api/v1${path}`, { method }),
  );

  expect(response.status).toBe(503);
  expect(exception).toHaveBeenCalledOnce();
  expect(exception.mock.calls[0]?.[0]).toBe(error);
  exception.mockClear();
  vi.spyOn(runtime.identity, "authenticate").mockResolvedValue(
    Result.err(new AuthenticationFailed({ code: "UNAUTHORIZED", message: "Sign in" })),
  );
  expect(
    (await createApi(runtime)(new Request(`http://localhost/api/v1${path}`, { method }))).status,
  ).toBe(401);
  expect(exception).not.toHaveBeenCalled();
});

it("captures internal authentication errors while preserving responses and ignoring 4xx", async () => {
  const original = new Error("Authentication provider unavailable");

  const auth = createAuthentication(environment.configuration, environment.database.db, {
    observation: { capture: () => {}, exception, close: async () => {} },
    authentication: {
      plugins: [
        {
          id: "error-fixture",
          endpoints: {
            broken: createAuthEndpoint("/fixture-broken", { method: "GET" }, async () => {
              throw original;
            }),
            denied: createAuthEndpoint("/fixture-denied", { method: "GET" }, async () => {
              throw new APIError("FORBIDDEN");
            }),
          },
        },
      ],
    },
  });

  const request = (path: string) =>
    new Request(`${environment.configuration.PLATFORM_URL}/api/auth/${path}`);

  expect((await auth.handler(request("fixture-broken"))).status).toBe(500);
  expect(exception).toHaveBeenCalledExactlyOnceWith(original);
  exception.mockClear();
  expect((await auth.handler(request("fixture-denied"))).status).toBe(403);
  expect(exception).not.toHaveBeenCalled();

  exception.mockImplementationOnce(() => {
    throw new Error("Observer unavailable");
  });
  expect((await auth.handler(request("fixture-broken"))).status).toBe(500);
});

it("captures a binary upload's storage error and preserves its cause", async () => {
  vi.spyOn(runtime.identity, "authenticate").mockResolvedValue(
    Result.ok({
      ...environment.owner,
      role: "owner",
      admin: true,
      creator: true,
      application: environment.application,
    }),
  );

  const error = new StorageUnavailable({
    message: "Upload storage unavailable",
    cause: new Error("Bucket disconnected"),
  });

  vi.spyOn(runtime.uploads, "putAsset").mockResolvedValue(Result.err(error));

  const response = await createApi(runtime)(
    new Request(
      `http://localhost/api/v1/apps/${crypto.randomUUID()}/assets/${crypto.randomUUID()}/${"a".repeat(32)}`,
      { method: "PUT", body: "fixture" },
    ),
  );

  expect(response.status).toBe(503);
  expect(exception).toHaveBeenCalledOnce();
  expect(exception.mock.calls[0]?.[0]).toBe(error);
});
