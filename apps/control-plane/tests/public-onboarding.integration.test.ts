import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnvironment } from "./environment.ts";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createRuntime } from "../src/lib/server/runtime-services.ts";
import { createApi } from "../src/lib/server/api.ts";
import { createStorage } from "../src/lib/server/storage.ts";
import { member, session, user } from "../src/lib/server/auth-schema.ts";
import type { EmailMessage } from "../src/lib/server/email.ts";

describe("Public account registration and organization onboarding", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  const messages: EmailMessage[] = [];
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => environment?.close());

  const authentication = (publicSignup: boolean) =>
    createAuthentication(environment.configuration, environment.database.db, {
      publicSignup,
      sendEmail: async (message) => {
        messages.push(message);
      },
    });

  const register = async (email: string) => {
    const auth = authentication(true);
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const code = messages.findLast((message) => message.to === email)?.text.match(/\b\d{6}\b/)?.[0];

    if (!code) throw new Error("Expected a synthetic code");

    const result = await auth.api.signInEmailOTP({
      body: { email, otp: code, name: "New Person" },
    });

    const { headers } = await environment.users.login({ userId: result.user.id });

    return { auth, result, headers: new Headers(headers) };
  };

  it("keeps registration closed by default and requires delivered verification before creating accounts", async () => {
    const email = "new-person@mail.test";
    const before = messages.length;
    await authentication(false).api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    expect(messages).toHaveLength(before);
    await expect(
      authentication(true).api.signInEmailOTP({ body: { email, otp: "000000" } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await environment.database.db.select().from(user).where(eq(user.email, email))).toEqual(
      [],
    );
    const { auth, result, headers } = await register(email);
    expect(result.user).toMatchObject({ name: "New Person", emailVerified: true });
    expect(
      await environment.database.db.select().from(member).where(eq(member.userId, result.user.id)),
    ).toEqual([]);

    const identity = createIdentityService(
      auth,
      environment.database.db,
      environment.configuration,
    );

    expect(
      (
        await identity.organizations(
          new Request(`${environment.configuration.PLATFORM_URL}/api/v1/organizations`, {
            headers,
          }),
        )
      ).unwrap(),
    ).toEqual([]);
    expect(
      (
        await identity.authenticate(
          new Request(`${environment.configuration.PLATFORM_URL}/api/v1/apps`, { headers }),
          "platform:read",
        )
      ).isErr(),
    ).toBe(true);
    const repeated = await register(email);
    expect(repeated.result.user.id).toBe(result.user.id);
  });

  it("cannot use console codes or an absent mail adapter for public registration", () => {
    expect(() =>
      createAuthentication(environment.configuration, environment.database.db, {
        publicSignup: true,
      }),
    ).toThrow("requires email delivery");
    expect(() =>
      createAuthentication(
        { ...environment.configuration, LOGIN_CODE_DELIVERY: "console" },
        environment.database.db,
        { publicSignup: true, sendEmail: async () => {} },
      ),
    ).toThrow("requires email delivery");
  });

  it("keeps a self-hosted runtime closed to organization creation without an extension", async () => {
    const runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: environment.settings,
      reporting: environment.reporting,
      storage: createStorage(environment.configuration),
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
    })();

    const { headers } = await register("self-hosted-account@mail.test");
    headers.set("content-type", "application/json");
    headers.set("origin", environment.configuration.PLATFORM_URL);

    const response = await createApi(runtime)(
      new Request(`${environment.configuration.PLATFORM_URL}/api/v1/organizations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Another Team", slug: "another-team" }),
      }),
    );

    expect(runtime.publicSignup).toBe(false);
    expect(response.status).toBe(403);
  });

  it("authenticates organization creation independently of membership and rejects foreign origins and company sessions", async () => {
    const calls: string[] = [];
    const record = { id: crypto.randomUUID(), name: "My Team", slug: "my-team" };

    const runtime = await createRuntime({
      configuration: environment.configuration,
      database: environment.database,
      settings: {
        ...environment.settings,
        publish: async () => ({
          ...(await environment.settings.inspect()),
          error: null,
          activation: { state: "active", message: "Synthetic publication", revision: "test" },
        }),
      },
      reporting: environment.reporting,
      storage: createStorage(environment.configuration),
      encryptionKey: environment.environment.PLATFORM_ENCRYPTION_KEY,
      sendEmail: async (message) => {
        messages.push(message);
      },
      createOrganization: async (ownerId) => {
        calls.push(ownerId);

        return record;
      },
    })();

    const api = createApi(runtime);
    const { headers, result } = await register("api-signup@mail.test");

    const request = (credentials: Headers) =>
      new Request(`${environment.configuration.PLATFORM_URL}/api/v1/organizations`, {
        method: "POST",
        headers: credentials,
        body: JSON.stringify({ name: record.name, slug: record.slug }),
      });

    headers.set("content-type", "application/json");
    headers.set("origin", "https://foreign.example.test");
    expect((await api(request(headers))).status).toBe(403);
    expect(calls).toEqual([]);
    headers.set("origin", environment.configuration.PLATFORM_URL);
    const response = await api(request(headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(record);
    expect(calls).toEqual([result.user.id]);
    await environment.database.db
      .update(session)
      .set({ identityOrganizationId: "widefleet" })
      .where(eq(session.userId, result.user.id));
    expect((await api(request(headers))).status).toBe(403);
    expect(calls).toHaveLength(1);

    const anonymous = new Headers({
      "content-type": "application/json",
      origin: environment.configuration.PLATFORM_URL,
    });

    expect((await api(request(anonymous))).status).toBe(401);
  });
});
