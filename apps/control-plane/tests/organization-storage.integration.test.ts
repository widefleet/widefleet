import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settingsInput } from "@platform/contracts";
import { organization } from "../src/lib/server/auth-schema.ts";
import { createTestEnvironment } from "./environment.ts";

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

      const input = settingsInput.parse({
        externallyManaged: false,
        identity: {
          provider: environment.configuration.IDENTITY.provider,
          management: { clientId: name, secret: { type: "value", value: `${name}-secret` } },
          apps: { clientId: name, secret: { type: "value", value: `${name}-apps-secret` } },
        },
      });

      await environment.settings.initialize(input, id);

      return { id, input };
    };

    const first = await createOrganization("first");
    const second = await createOrganization("second");
    const firstSettings = (await environment.settings.resolve(first.id)).state.settings;

    const foreign = settingsInput.parse({
      ...second.input,
      identity: { ...second.input.identity, management: firstSettings.identity?.management },
    });

    await expect(environment.settings.initialize(foreign, second.id)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const replacement = settingsInput.parse(second.input);

    if (!replacement.identity) throw new Error("Missing fixture identity");
    replacement.identity.management.secret = { type: "value", value: "rotated-second-secret" };
    await environment.settings.initialize(replacement, second.id);
    expect((await environment.settings.resolve(first.id)).identity?.management.clientSecret).toBe(
      "first-secret",
    );
    expect((await environment.settings.resolve(second.id)).identity?.management.clientSecret).toBe(
      "rotated-second-secret",
    );
  });
});
