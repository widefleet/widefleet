import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { settingsInput } from "@platform/contracts";
import {
  account,
  member,
  organization,
  oauthRefreshToken,
  session,
  ssoProvider,
} from "../src/lib/server/auth-schema.ts";
import { organizationRuntimes } from "../src/lib/server/schema.ts";
import * as encryption from "../src/lib/server/secret-encryption.ts";
import { createSettingsService } from "../src/lib/server/settings.ts";
import { cliClientId } from "../src/lib/server/auth-options.ts";
import { createTestEnvironment, organizationCredential } from "./environment.ts";

describe("Organization login settings", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let settings: ReturnType<typeof createSettingsService>;

  beforeAll(async () => {
    environment = await createTestEnvironment();
    settings = createSettingsService(
      environment.configuration,
      environment.database.db,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      () => null,
      true,
    );
  });
  afterAll(async () => environment?.close());

  const company = async (slug: string) => {
    const organizationId = crypto.randomUUID();
    await environment.database.db
      .insert(organization)
      .values({ id: organizationId, name: slug, slug, createdAt: new Date() });
    await environment.database.db.insert(organizationRuntimes).values({ organizationId });
    await environment.database.db.insert(member).values({
      id: crypto.randomUUID(),
      userId: environment.owner.id,
      organizationId,
      role: "owner",
      createdAt: new Date(),
    });

    const input = settingsInput.parse({
      identity: {
        domain: "example.test",
        provider: environment.configuration.IDENTITY.provider,
        management: {
          clientId: `${slug}-management`,
          secret: { type: "value", value: `${slug}-management-secret` },
        },
        apps: { clientId: `${slug}-apps`, secret: { type: "value", value: `${slug}-apps-secret` } },
      },
      externallyManaged: false,
    });

    await settings.initialize(input, organizationId);
    await environment.database.db
      .update(ssoProvider)
      .set({ domainVerified: true })
      .where(eq(ssoProvider.organizationId, organizationId));

    const principal = {
      ...environment.owner,
      role: "owner" as const,
      admin: false,
      creator: true,
      application: { organizationId, admin: true },
    };

    return { organizationId, principal, input };
  };

  it("rejects foreign stored credentials and preserves them when another organization saves", async () => {
    const first = await company("settings-first");
    const second = await company("settings-second");
    const saved = await settings.read(first.principal);

    const foreign = settingsInput.parse({
      ...second.input,
      identity: {
        ...second.input.identity,
        management: saved.settings.identity?.management,
      },
    });

    await expect(
      settings.update(
        second.principal,
        { ...foreign, acknowledgeRestart: false },
        false,
        await organizationCredential(environment, second.principal),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await settings.resolve(second.organizationId)).identity?.management.clientSecret).toBe(
      "settings-second-management-secret",
    );
    await settings.update(
      second.principal,
      { identity: null, externallyManaged: false, acknowledgeRestart: false },
      false,
      await organizationCredential(environment, second.principal),
    );
    expect((await settings.resolve(first.organizationId)).identity?.management.clientSecret).toBe(
      "settings-first-management-secret",
    );
    expect((await settings.resolve(second.organizationId)).identity).toBeNull();
  });

  it("replaces SSO account bindings and revokes only that organization's login grants", async () => {
    const target = await company("settings-replacement");
    const other = await company("settings-unrelated");
    const credential = await organizationCredential(environment, target.principal);
    const unrelated = await organizationCredential(environment, other.principal);
    const current = await credential.auth.api.getSession({ headers: credential.headers });
    const otherSession = await unrelated.auth.api.getSession({ headers: unrelated.headers });

    if (!current || !otherSession) throw new Error("Missing fixture sessions");
    const original = await settings.read(target.principal);

    if (!original.sso || !original.settings.identity) throw new Error("Missing SSO fixture");
    await environment.database.db.insert(account).values({
      id: crypto.randomUUID(),
      userId: target.principal.id,
      accountId: "same-subject-can-exist-at-a-different-provider",
      providerId: original.sso.providerId,
    });
    const tokenId = crypto.randomUUID();
    await environment.database.db.insert(oauthRefreshToken).values({
      id: tokenId,
      token: crypto.randomUUID(),
      clientId: cliClientId,
      userId: target.principal.id,
      sessionId: current.session.id,
      referenceId: `organization:${target.organizationId}`,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ["platform:read"],
    });
    const changed = settingsInput.parse(original.settings);

    if (!changed.identity) throw new Error("Missing identity");
    changed.identity.management.clientId = "replacement-management-client";

    const updated = await settings.update(
      target.principal,
      { ...changed, acknowledgeRestart: false },
      false,
      credential,
    );

    expect(updated.sso?.verified).toBe(false);
    expect(updated.settings.identity?.management.secret).not.toEqual(
      original.settings.identity.management.secret,
    );
    expect(
      await environment.database.db
        .select()
        .from(account)
        .where(eq(account.providerId, original.sso.providerId)),
    ).toEqual([]);
    expect(
      await environment.database.db
        .select()
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.id, tokenId)),
    ).toEqual([]);
    expect(
      await environment.database.db
        .select()
        .from(session)
        .where(eq(session.id, current.session.id)),
    ).toEqual([]);
    expect(
      await environment.database.db
        .select()
        .from(session)
        .where(eq(session.id, otherSession.session.id)),
    ).toHaveLength(1);
  });

  it("reads the selected provider and observes rotation, deletion and wrong encryption keys", async () => {
    const first = await company("settings-rotation");
    const key = environment.environment.PLATFORM_ENCRYPTION_KEY;

    const [provider] = await environment.database.db
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, first.organizationId));

    if (!provider?.oidcConfig) throw new Error("Missing provider");

    const config = z
      .record(z.string(), z.json())
      .parse(JSON.parse(await encryption.decryptSecret(key, provider.oidcConfig)));

    await environment.database.db
      .update(ssoProvider)
      .set({
        oidcConfig: await encryption.encryptSecret(
          key,
          JSON.stringify({ ...config, clientSecret: "rotated-login-secret" }),
        ),
      })
      .where(eq(ssoProvider.id, provider.id));
    expect((await settings.resolve(first.organizationId)).identity?.management.clientSecret).toBe(
      "rotated-login-secret",
    );

    const wrongKey = createSettingsService(
      environment.configuration,
      environment.database.db,
      "wrong-test-key",
      () => null,
    );

    expect((await wrongKey.resolve(first.organizationId)).identity).toBeNull();
    await environment.database.db.delete(ssoProvider).where(eq(ssoProvider.id, provider.id));
    expect((await settings.resolve(first.organizationId)).identity).toBeNull();
  });
});
