import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { Result } from "better-result";
import { createTestEnvironment } from "./environment.ts";
import { createRuntime, type Runtime } from "../src/lib/server/runtime-services.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { createApi } from "../src/lib/server/api.ts";
import { AuthenticationFailed } from "../src/lib/server/identity.ts";
import * as runtimeModule from "../src/lib/server/runtime.ts";
import { pageFailure, identityFailure } from "../src/lib/server/page-auth.ts";
import { remoteOperation } from "../src/lib/server/remote-support.ts";
import {
  DatabaseUnavailable,
  StorageUnavailable,
  InvalidOperation,
} from "../src/lib/server/errors.ts";

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
  vi.spyOn(runtimeModule, "getRuntime").mockResolvedValue(runtime);
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

it.each([false, true])(
  "captures internal authentication failures including APIError: %s",
  async (apiError) => {
    const original = apiError
      ? new APIError("SERVICE_UNAVAILABLE", { message: "Authentication unavailable" })
      : new Error("Authentication provider unavailable");

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

    expect((await auth.handler(request("fixture-broken"))).status).toBe(apiError ? 503 : 500);
    expect(exception).toHaveBeenCalledExactlyOnceWith(original);
    exception.mockClear();
    expect((await auth.handler(request("fixture-denied"))).status).toBe(403);
    expect(exception).not.toHaveBeenCalled();

    exception.mockImplementationOnce(() => {
      throw new Error("Observer unavailable");
    });
    expect((await auth.handler(request("fixture-broken"))).status).toBe(apiError ? 503 : 500);
  },
);

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

it.each(["identity", "database", "storage"])(
  "reports handled %s page failures without changing HTTP status",
  async (kind) => {
    const original = new Error("Unavailable connection");

    const cause =
      kind === "storage"
        ? new StorageUnavailable({ message: "Storage unavailable", cause: original })
        : new DatabaseUnavailable({ message: "Database unavailable", cause: original });

    try {
      if (kind === "identity" && cause instanceof DatabaseUnavailable)
        identityFailure(cause, new Request("http://localhost/"));
      else pageFailure(cause);
      expect.fail("Expected HTTP error");
    } catch (error) {
      expect(error).toMatchObject({
        status: 503,
        body: {
          message:
            kind === "identity"
              ? "Sign-in is temporarily unavailable."
              : kind === "storage"
                ? "File storage is temporarily unavailable."
                : "The database is temporarily unavailable.",
        },
      });
    }

    await vi.waitFor(() => expect(exception).toHaveBeenCalledOnce());
    expect(exception.mock.calls[0]?.[0]).toBe(original);
  },
);

it("reports server APIErrors in remote operations and skips expected client errors", async () => {
  const cause = new APIError("SERVICE_UNAVAILABLE", {
    message: "Authentication temporarily unavailable",
  });

  await expect(
    remoteOperation(async () => {
      throw cause;
    }),
  ).rejects.toMatchObject({ status: 503 });
  expect(exception).toHaveBeenCalledOnce();
  expect(exception.mock.calls[0]?.[0]).toBe(cause);
  exception.mockClear();
  await expect(
    remoteOperation(async () => {
      throw new APIError("FORBIDDEN");
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(() =>
    pageFailure(new InvalidOperation({ code: "NOT_FOUND", message: "App not found" })),
  ).toThrow();
  expect(exception).not.toHaveBeenCalled();
});

it("routes handled authentication failures through installation reporting without product analytics", async () => {
  const original = new Error("Authentication database unavailable");
  const reporting = vi.spyOn(environment.reporting, "exception").mockImplementation(() => {});

  const service = await createRuntime({
    configuration: environment.configuration,
    database: environment.database,
    settings: environment.settings,
    storage: createStorage(environment.configuration),
    reporting: environment.reporting,
    encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
    authentication: {
      plugins: [
        {
          id: "error-fixture",
          endpoints: {
            fail: createAuthEndpoint("/fixture-failure", { method: "GET" }, async () => {
              throw original;
            }),
          },
        },
      ],
    },
  })();

  const response = await service.auth.handler(
    new Request(`${environment.configuration.PLATFORM_URL}/api/auth/fixture-failure`),
  );

  expect(response.status).toBe(500);
  expect(reporting).toHaveBeenCalledOnce();
  expect(reporting.mock.calls[0]?.[0]).toBe(original);
});
