import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { organizationSettings } from "../src/lib/server/schema.ts";
import { decryptSecret } from "../src/lib/server/secret-encryption.ts";
import { settingsInput } from "@platform/contracts";
import { organization, member, ssoProvider } from "../src/lib/server/auth-schema.ts";
import { createTestEnvironment, organizationCredential } from "./environment.ts";

describe("Organization settings storage", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => environment?.close());

  it("keeps encrypted directory secrets isolated and preserves omitted credentials", async () => {
    const createOrganization = async (name: string) => {
      const id = crypto.randomUUID();
      await environment.database.db.insert(organization).values({
        id,
        name,
        slug: id,
        createdAt: new Date(),
      });

      await environment.database.db.insert(member).values({
        id: crypto.randomUUID(),
        organizationId: id,
        userId: environment.owner.id,
        role: "owner",
        createdAt: new Date(),
      });

      const credential = await organizationCredential(environment, {
        id: environment.owner.id,
        application: { organizationId: id },
      });

      const input = settingsInput.parse({
        appIdentity: { type: "entra" },
        directory: { clientId: name, clientSecret: `${name}-secret` },
        sso: {
          providerId: name,
          domain: "example.test",
          issuer: `${environment.environment.ENTRA_AUTHORITY}/${environment.environment.ENTRA_TENANT_ID}/v2.0`,
          oidcConfig: { clientId: name, clientSecret: `${name}-login-secret` },
        },
      });

      await environment.settings.initialize(input, id, credential);
      await environment.database.db
        .update(ssoProvider)
        .set({ domainVerified: true })
        .where(eq(ssoProvider.organizationId, id));

      await environment.database.db
        .update(organizationSettings)
        .set({ ssoRequired: true })
        .where(eq(organizationSettings.organizationId, id));

      return { id, input, credential };
    };

    const first = await createOrganization("first");
    const second = await createOrganization("second");
    const firstSettings = (await environment.settings.resolve(first.id)).state.settings;

    expect(firstSettings.directory).toEqual({ clientId: "first" });
    // Importing another organization's public settings never imports its secret.
    const copied = settingsInput.parse({ ...second.input, directory: firstSettings.directory });
    await environment.settings.initialize(copied, second.id, second.credential);
    expect((await environment.settings.resolve(second.id)).identity?.directory?.clientSecret).toBe(
      "second-secret",
    );

    const replacement = settingsInput.parse({
      ...second.input,
      directory: { clientId: "second", clientSecret: "rotated-second-secret" },
    });

    await environment.settings.initialize(replacement, second.id, second.credential);
    expect((await environment.settings.resolve(first.id)).identity?.directory?.clientSecret).toBe(
      "first-secret",
    );
    expect((await environment.settings.resolve(second.id)).identity?.directory?.clientSecret).toBe(
      "rotated-second-secret",
    );

    const [saved] = await environment.database.db
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, second.id));

    expect(saved?.directorySecret).not.toBe("rotated-second-secret");
    expect(
      await decryptSecret(
        environment.environment.PLATFORM_ENCRYPTION_KEY,
        saved?.directorySecret ?? "",
      ),
    ).toBe("rotated-second-secret");
    expect(JSON.stringify(saved?.settings)).not.toContain("secret");
    await environment.settings.initialize(
      { ...replacement, directory: null },
      second.id,
      second.credential,
    );

    const [cleared] = await environment.database.db
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, second.id));

    expect(cleared?.directorySecret).toBeNull();
    await expect(
      environment.settings.initialize(copied, second.id, second.credential),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
