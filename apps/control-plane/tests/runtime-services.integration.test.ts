import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { editableSettings } from "./settings-input.ts";
import { createRuntime, createRequestRuntime } from "../src/lib/server/runtime-services.ts";
import { organizationSettings } from "../src/lib/server/schema.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createTestEnvironment, organizationCredential } from "./environment.ts";

describe("Operator configuration and organization settings", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

  const runtime = () =>
    createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      storage: createStorage(environment.configuration),
      reporting: environment.reporting,
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
    });

  beforeEach(async () => {
    environment = await createTestEnvironment();
    await environment.database.db.update(ssoProvider).set({ domainVerified: true });
  });

  afterEach(async () => {
    await environment.reporting.close();
    await environment.close();
  });

  it("constructs authentication without loading settings, including on later requests", async () => {
    const reads = vi
      .spyOn(environment.settings, "resolve")
      .mockRejectedValue(new Error("Settings unavailable"));

    const resolve = runtime();
    const request = createRequestRuntime(resolve);
    const [first, simultaneous] = await Promise.all([request(), request()]);
    expect(simultaneous).toBe(first);
    expect(await createRequestRuntime(resolve)()).toBe(first);
    expect(reads).not.toHaveBeenCalled();
  });

  it("serves authenticated app requests without decrypting unrelated operator credentials", async () => {
    const session = await environment.users.login({ userId: environment.owner.id });
    await environment.database.db
      .update(organizationSettings)
      .set({ ssoRequired: false, directorySecret: "invalid-ciphertext" });
    await environment.database.db.update(ssoProvider).set({ oidcConfig: "invalid-ciphertext" });
    // This would fail the old pre-request settings load before authentication or routing.
    await expect(environment.settings.resolve()).rejects.toThrow();
    const current = await runtime()();
    const api = createApi(current);

    const request = (path: string) =>
      new Request(`${environment.configuration.PLATFORM_URL}/api/v1${path}`, {
        headers: new Headers(session.headers),
      });

    expect((await api(request("/me"))).status).toBe(200);
    expect(await (await api(request("/apps"))).json()).toEqual([]);
    expect(
      (await api(new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps`))).status,
    ).toBe(401);
  });

  it("reads edited SSO providers through the native plugin without rebuilding authentication", async () => {
    const resolve = runtime();
    const current = await resolve();
    const input = editableSettings(await environment.settings.inspect());

    if (!input.sso) throw new Error("Expected fixture SSO provider");

    const startSignIn = async () => {
      const origin = environment.configuration.PLATFORM_URL;

      const response = await current.auth.handler(
        new Request(`${origin}/api/auth/sign-in/sso`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ providerId: input.sso?.providerId, callbackURL: "/" }),
        }),
      );

      expect(response.status).toBe(200);

      return new URL(z.object({ url: z.url() }).parse(await response.json()).url);
    };

    expect((await startSignIn()).searchParams.get("client_id")).toBe(input.sso.oidcConfig.clientId);
    input.sso.oidcConfig.clientId = "updated-organization-client";
    await environment.settings.initialize(
      input,
      "widefleet",
      await organizationCredential(environment, {
        id: environment.owner.id,
        application: { organizationId: "widefleet" },
      }),
    );
    expect(await resolve()).toBe(current);
    expect((await startSignIn()).searchParams.get("client_id")).toBe("updated-organization-client");
  });
});
