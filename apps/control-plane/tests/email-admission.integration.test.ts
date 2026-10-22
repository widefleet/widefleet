import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { invitation, user } from "../src/lib/server/auth-schema.ts";
import { prepareOrganizationInvitation } from "../src/lib/server/members.ts";
import type { EmailMessage } from "../src/lib/server/email.ts";
import { createTestEnvironment } from "./environment.ts";

describe("Email sign-in admission", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  const messages: EmailMessage[] = [];
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => environment?.close());

  const authentication = (admitted = true) =>
    createAuthentication(environment.configuration, environment.database.db, {
      sendEmail: async (message) => {
        messages.push(message);
      },
      organizationAccess: {
        filterOrganizations: async (organizations) =>
          admitted ? organizations.map(({ id }) => id) : [],
      },
    });

  it("normalizes mixed-case input and signs in the existing member without creating another user", async () => {
    const auth = authentication();
    await auth.api.sendVerificationOTP({
      body: { email: environment.owner.email.toUpperCase(), type: "sign-in" },
    });
    const otp = messages.at(-1)?.text.match(/\b\d{6}\b/)?.[0];

    if (!otp) throw new Error("Missing captured sign-in code");

    const result = await auth.api.signInEmailOTP({
      body: { email: environment.owner.email.toUpperCase(), otp },
    });

    expect(result.user.id).toBe(environment.owner.id);
    expect(result.user.email).toBe(environment.owner.email.toLowerCase());
    expect(result.user.emailVerified).toBe(true);
    expect(await environment.database.db.select().from(user)).toHaveLength(1);
  });

  it("does not send codes or create users for unknown or suspended organizations", async () => {
    const before = messages.length;
    const unknown = "uninvited@example.test";
    await authentication().api.sendVerificationOTP({ body: { email: unknown, type: "sign-in" } });
    await authentication(false).api.sendVerificationOTP({
      body: { email: environment.owner.email, type: "sign-in" },
    });
    expect(messages).toHaveLength(before);
    expect(
      await environment.database.db.select().from(user).where(eq(user.email, unknown)),
    ).toEqual([]);
    await expect(
      authentication().api.signInEmailOTP({ body: { email: unknown, otp: "123456" } }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: "INVALID_OTP" } });
  });

  it("uses the same HTTP error for a wrong native code and denied email admission", async () => {
    const auth = authentication();
    await auth.api.sendVerificationOTP({
      body: { email: environment.owner.email, type: "sign-in" },
    });
    const valid = messages.at(-1)?.text.match(/\b\d{6}\b/)?.[0];

    if (!valid) throw new Error("Missing captured sign-in code");
    const wrong = valid === "000000" ? "111111" : "000000";

    const attempt = async (email: string) => {
      const response = await auth.handler(
        new Request(`${environment.configuration.PLATFORM_URL}/api/auth/sign-in/email-otp`, {
          method: "POST",
          headers: {
            origin: environment.configuration.PLATFORM_URL,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email, otp: wrong }),
        }),
      );

      return { status: response.status, body: z.json().parse(await response.json()) };
    };

    const native = await attempt(environment.owner.email);
    expect(native).toMatchObject({ status: 400, body: { code: "INVALID_OTP" } });
    expect(await attempt("uninvited@example.test")).toEqual(native);
    await expect(
      auth.api.signInEmailOTP({ body: { email: environment.owner.email, otp: valid } }),
    ).resolves.toMatchObject({ user: { id: environment.owner.id } });
  });

  it("rechecks admission after delivery when an invitation is canceled or an organization suspended", async () => {
    const email = "revoked-invitation@example.test";

    const prepared = await prepareOrganizationInvitation(
      environment.database.db,
      "widefleet",
      environment.owner.id,
      { email, role: "member" },
    );

    const auth = authentication();
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const otp = messages.at(-1)?.text.match(/\b\d{6}\b/)?.[0];

    if (!otp) throw new Error("Missing captured sign-in code");
    await environment.database.db
      .update(invitation)
      .set({ status: "canceled" })
      .where(eq(invitation.id, prepared.invitation.id));
    await expect(auth.api.signInEmailOTP({ body: { email, otp } })).rejects.toMatchObject({
      statusCode: 400,
      body: { code: "INVALID_OTP" },
    });
    expect(await environment.database.db.select().from(user).where(eq(user.email, email))).toEqual(
      [],
    );

    await auth.api.sendVerificationOTP({
      body: { email: environment.owner.email, type: "sign-in" },
    });
    const ownerCode = messages.at(-1)?.text.match(/\b\d{6}\b/)?.[0];

    if (!ownerCode) throw new Error("Missing captured sign-in code");
    await expect(
      authentication(false).api.signInEmailOTP({
        body: { email: environment.owner.email, otp: ownerCode },
      }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: "INVALID_OTP" } });
  });
});
