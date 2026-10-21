import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { user } from "../src/lib/server/auth-schema.ts";
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

  it("signs an existing member in with a captured code and a verified email", async () => {
    const auth = authentication();
    await auth.api.sendVerificationOTP({
      body: { email: environment.owner.email, type: "sign-in" },
    });
    const otp = messages.at(-1)?.text.match(/\b\d{6}\b/)?.[0];

    if (!otp) throw new Error("Missing captured sign-in code");
    const result = await auth.api.signInEmailOTP({ body: { email: environment.owner.email, otp } });
    expect(result.user.id).toBe(environment.owner.id);
    expect(result.user.emailVerified).toBe(true);
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
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
