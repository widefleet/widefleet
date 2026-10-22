import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createAuthenticationAdmission } from "../src/lib/server/auth-admission.ts";
import { organization, ssoProvider } from "../src/lib/server/auth-schema.ts";
import { createTestEnvironment } from "./environment.ts";

describe("Email-first sign-in discovery", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    await environment.database.db.update(ssoProvider).set({ domainVerified: true });
  });
  afterAll(async () => environment?.close());

  const discover = (email: string) =>
    createAuthenticationAdmission(environment.database.db).signInProvider(email);

  it("routes the exact verified email domain without requiring an existing account", async () => {
    await expect(discover("  New.Person@EXAMPLE.TEST  ")).resolves.toBe("microsoft");
    await expect(discover("person@other.test")).resolves.toBeNull();
    await expect(discover("person@sub.example.test")).resolves.toBeNull();
    await expect(discover("person@notexample.test")).resolves.toBeNull();
  });

  it("does not discover an unverified or unadmitted SSO provider", async () => {
    const suspended = createAuthenticationAdmission(environment.database.db, {
      filterOrganizations: async () => [],
    });

    await expect(suspended.signInProvider("person@example.test")).resolves.toBeNull();
    await environment.database.db.update(ssoProvider).set({ domainVerified: false });

    try {
      await expect(discover("person@example.test")).resolves.toBeNull();
    } finally {
      await environment.database.db.update(ssoProvider).set({ domainVerified: true });
    }
  });

  it("requires an organization link when multiple admitted providers share a domain", async () => {
    const organizationId = crypto.randomUUID();
    await environment.database.db.insert(organization).values({
      id: organizationId,
      name: "Second company",
      slug: "second-company",
      createdAt: new Date(),
    });
    await environment.database.db.insert(ssoProvider).values({
      id: crypto.randomUUID(),
      providerId: "second-company",
      organizationId,
      issuer: "https://sso.example.test",
      domain: "example.test",
      domainVerified: true,
    });

    try {
      const hosted = createAuthenticationAdmission(environment.database.db, {
        filterOrganizations: async (candidates) => candidates.map(({ id }) => id),
      });

      await expect(hosted.signInProvider("person@example.test")).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Use the sign-in link provided by your organization.",
      });
      // The self-hosted installation still resolves only its own provider.
      await expect(discover("person@example.test")).resolves.toBe("microsoft");
    } finally {
      await environment.database.db.delete(organization).where(eq(organization.id, organizationId));
    }
  });
});
