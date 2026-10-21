import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { settingsInput } from "@platform/contracts";
import { organization, member, ssoProvider } from "../src/lib/server/auth-schema.ts";
import { createTestEnvironment, organizationCredential } from "./environment.ts";

describe("Organization settings storage", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => environment?.close());

  it("rejects foreign secret references and preserves other organizations when replacing settings", async () => {
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
        directory: { clientId: name, secret: { type: "value", value: `${name}-secret` } },
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

      return { id, input, credential };
    };

    const first = await createOrganization("first");
    const second = await createOrganization("second");
    const firstSettings = (await environment.settings.resolve(first.id)).state.settings;

    const foreign = settingsInput.parse({
      ...second.input,
      directory: firstSettings.directory,
    });

    await expect(
      environment.settings.initialize(foreign, second.id, second.credential),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const replacement = settingsInput.parse(second.input);

    if (!replacement.directory) throw new Error("Missing fixture identity");
    replacement.directory.secret = { type: "value", value: "rotated-second-secret" };
    await environment.settings.initialize(replacement, second.id, second.credential);
    expect((await environment.settings.resolve(first.id)).identity?.directory?.clientSecret).toBe(
      "first-secret",
    );
    expect((await environment.settings.resolve(second.id)).identity?.directory?.clientSecret).toBe(
      "rotated-second-secret",
    );
  });
});
