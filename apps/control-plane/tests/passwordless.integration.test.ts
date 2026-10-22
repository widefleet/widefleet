import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { configurationSchema } from "../src/lib/server/config.ts";
import { createTestEnvironment } from "./environment.ts";

describe("Passwordless sign-in delivery", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => environment?.close());

  it("requires an explicit console mode and rejects invalid delivery settings", () => {
    expect(configurationSchema.parse(environment.environment).LOGIN_CODE_DELIVERY).toBe("email");
    expect(
      configurationSchema.safeParse({ ...environment.environment, LOGIN_CODE_DELIVERY: "typo" })
        .success,
    ).toBe(false);
  });

  it("uses native one-time codes and sessions in console mode while preserving required SSO", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sendEmail = vi.fn(async () => undefined);

    const auth = createAuthentication(
      { ...environment.configuration, LOGIN_CODE_DELIVERY: "console" },
      environment.database.db,
      { sendEmail },
    );

    try {
      await auth.api.sendVerificationOTP({
        body: { email: environment.owner.email, type: "sign-in" },
      });
      expect(sendEmail).not.toHaveBeenCalled();
      const text = output.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(text).toContain(environment.owner.email);
      const otp = text.match(/code is (\d{6})/)?.[1];

      if (!otp) throw new Error("Expected the native sign-in code in the console transport");

      const login = await auth.api.signInEmailOTP({
        body: { email: environment.owner.email, otp },
        returnHeaders: true,
      });

      expect(login.response.user).toMatchObject({ id: environment.owner.id, emailVerified: true });
      await expect(
        auth.api.signInEmailOTP({ body: { email: environment.owner.email, otp } }),
      ).rejects.toBeDefined();

      const headers = new Headers({
        cookie: login.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
      });

      expect((await auth.api.getSession({ headers }))?.user.id).toBe(environment.owner.id);
      await environment.database.db
        .update(ssoProvider)
        .set({ domainVerified: true })
        .where(eq(ssoProvider.organizationId, "widefleet"));

      const identity = createIdentityService(
        auth,
        environment.database.db,
        environment.configuration,
      );

      expect(
        (
          await identity.authenticate(
            new Request(environment.configuration.PLATFORM_URL, { headers }),
            "platform:read",
          )
        ).isErr(),
      ).toBe(true);
      const before = output.mock.calls.length;
      await auth.api.sendVerificationOTP({
        body: { email: "unknown@example.test", type: "sign-in" },
      });
      expect(output.mock.calls).toHaveLength(before);
    } finally {
      output.mockRestore();
    }
  });

  it("never falls back to logs when mail is missing or fails", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const missing = createAuthentication(environment.configuration, environment.database.db);
      await expect(
        missing.api.sendVerificationOTP({
          body: { email: environment.owner.email, type: "sign-in" },
        }),
      ).rejects.toBeDefined();

      const sendEmail = vi.fn(async () => {
        throw new Error("Synthetic mail outage");
      });

      const failed = createAuthentication(environment.configuration, environment.database.db, {
        sendEmail,
      });

      // Native OTP delivery conceals mail failures to avoid account enumeration.
      await failed.api.sendVerificationOTP({
        body: { email: environment.owner.email, type: "sign-in" },
      });
      expect(sendEmail).toHaveBeenCalledOnce();
      expect(output).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });

  it("does not expose password sign-in or password creation", async () => {
    const auth = createAuthentication(environment.configuration, environment.database.db);

    for (const path of [
      "/sign-in/email",
      "/sign-up/email",
      "/set-password",
      "/request-password-reset",
      "/reset-password",
    ]) {
      const origin = environment.configuration.PLATFORM_URL;

      const response = await auth.handler(
        new Request(`${origin}/api/auth${path}`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            email: environment.owner.email,
            password: "removed-local-password",
          }),
        }),
      );

      expect(response.status).toBe(404);
    }
  });
});
