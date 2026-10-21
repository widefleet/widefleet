import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { initializeRuntime } from "../src/lib/server/runtime-initialization.ts";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editableSettings } from "./settings-input.ts";
import { installationSettings, settingsInput } from "@platform/contracts";
import { createAuthentication, companyLoginRevision } from "../src/lib/server/auth.ts";
import { member, session, user, ssoProvider } from "../src/lib/server/auth-schema.ts";
import { installation, organizationSettings } from "../src/lib/server/schema.ts";
import {
  createInstallationOwner,
  installationId,
  readInstallation,
} from "../src/lib/server/installation-store.ts";
import { createRecoveryLink } from "../src/lib/server/recovery.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createTestEnvironment, organizationCredential } from "./environment.ts";
import { createSettingsService } from "../src/lib/server/settings.ts";
import type { AppSignIn } from "../src/lib/server/app-sign-in.ts";
import { createInstalledAppSignIn } from "../src/lib/server/app-sign-in-installed.ts";

describe("Platform setup and managed settings", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
    await environment.database.db.update(ssoProvider).set({ domainVerified: true });
    await environment.settings.publish();
  });
  afterAll(async () => {
    await environment.close();
  });

  const principal = () => ({
    ...environment.owner,
    application: { ...environment.application, admin: true },
    role: "owner" as const,
    admin: true,
    creator: true,
  });

  const input = async () => editableSettings(await environment.settings.read(principal()));

  it("claims first-administrator setup once and stores a Better Auth password account", async () => {
    await environment.database.db
      .update(installation)
      .set({ ownerId: null })
      .where(eq(installation.id, installationId));

    const attempts = await Promise.allSettled(
      ["first", "second"].map((name) =>
        createInstallationOwner(environment.database.db, {
          name,
          email: `${name}@example.test`,
          password: "first-owner-password",
        }),
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const winner = attempts.find((attempt) => attempt.status === "fulfilled");

    if (!winner || winner.status !== "fulfilled") throw new Error("Expected a setup owner");
    await environment.database.db.delete(user).where(eq(user.id, environment.owner.id));
    environment.owner = winner.value;
    const roles = await environment.database.db.select().from(member);
    expect(roles).toEqual([expect.objectContaining({ userId: winner.value.id, role: "owner" })]);

    const auth = createAuthentication(
      { ...environment.configuration, LOCAL_PASSWORD_ENABLED: true },
      environment.database.db,
    );

    const result = await auth.api.signInEmail({
      body: { email: winner.value.email, password: "first-owner-password" },
    });

    expect(result.user.id).toBe(winner.value.id);
  });

  it("encrypts entered credentials and never returns them in settings", async () => {
    const current = await input();

    if (!current.sso) throw new Error("Expected configured identity");
    current.sso.oidcConfig.clientSecret = "private-management-secret";

    const result = await environment.settings.update(
      principal(),
      { ...current, acknowledgeRestart: false },
      true,
      await organizationCredential(environment, principal()),
    );

    expect(JSON.stringify(result)).not.toContain("private-management-secret");
    expect(result.sso?.oidcConfig).not.toHaveProperty("clientSecret");

    const [stored] = await environment.database.db
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, "widefleet"));

    expect(stored?.oidcConfig).not.toContain("private-management-secret");
    expect((await environment.settings.resolve()).identity?.management.clientSecret).toBe(
      "private-management-secret",
    );
    expect(() =>
      installationSettings.parse({ ...result.settings, identity: current.sso }),
    ).toThrow();
  });

  it("preserves the native secret on export/import and publishes one registration to apps", async () => {
    const current = await input();
    expect(current.sso?.oidcConfig.clientSecret).toBeUndefined();
    await environment.settings.update(
      principal(),
      { ...current, acknowledgeRestart: false },
      true,
      await organizationCredential(environment, principal()),
    );
    expect((await environment.settings.resolve()).identity?.management.clientSecret).toBe(
      "private-management-secret",
    );
    expect(environment.authControl.read().configuration?.clientSecret).toBe(
      "private-management-secret",
    );
    expect(environment.authControl.read().configuration?.clientId).toBe(
      current.sso?.oidcConfig.clientId,
    );
    const [saved] = await environment.database.db.select().from(organizationSettings);
    expect(saved?.settings).not.toHaveProperty("identity");
    expect(saved?.settings).not.toHaveProperty("sso");
    expect(saved?.directorySecret).toBeNull();
  });

  it("enforces administrator access and browser read-only while allowing API changes", async () => {
    const viewer = {
      ...principal(),
      role: "member" as const,
      admin: false,
      application: { ...environment.application, admin: false },
    };

    await expect(environment.settings.read(viewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await environment.settings.setExternalManagement(principal(), true);
    const current = await input();
    await expect(
      environment.settings.update(
        principal(),
        { ...current, acknowledgeRestart: false },
        true,
        await organizationCredential(environment, principal()),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      environment.settings.update(
        principal(),
        { ...current, acknowledgeRestart: false },
        false,
        await organizationCredential(environment, principal()),
      ),
    ).resolves.toMatchObject({ settings: { externallyManaged: true } });
    await environment.settings.setExternalManagement(principal(), false);
  });

  it("applies client changes without restarting the auth proxy", async () => {
    const current = await input();

    if (!current.sso) throw new Error("Expected configured identity");
    current.sso.oidcConfig.clientSecret = "rotated-app-secret";
    current.sso.oidcConfig.clientId = "replacement-app-client";
    expect(await environment.settings.plan(principal(), current)).toMatchObject({
      restartRequired: false,
    });
    await environment.settings.update(
      principal(),
      { ...current, acknowledgeRestart: false },
      true,
      await organizationCredential(environment, principal()),
    );
    expect((await input()).sso?.oidcConfig.clientId).toBe("replacement-app-client");

    const bundle = environment.authControl.read();

    expect(bundle.configuration?.clientId).toBe("replacement-app-client");
    expect(bundle.configuration?.clientSecret).toBe("rotated-app-secret");
  });

  it("reads installed status without publishing and reports unavailable or unapplied settings", async () => {
    const current = await input();
    const before = environment.authControl.read().publications;
    await environment.settings.resolve();
    await environment.settings.read(principal());
    expect(environment.authControl.read().publications).toBe(before);

    if (!current.sso) throw new Error("Expected configured identity");
    current.sso.oidcConfig.clientId = "not-yet-installed-client";
    environment.authControl.available(false);

    try {
      expect((await environment.settings.read(principal())).activation.state).toBe("failed");
      expect(
        (
          await environment.settings.update(
            principal(),
            { ...current, acknowledgeRestart: false },
            true,
            await organizationCredential(environment, principal()),
          )
        ).error,
      ).toBe("App sign-in could not be prepared");
    } finally {
      environment.authControl.available(true);
    }

    expect((await environment.settings.read(principal())).activation.state).toBe("failed");
    expect(environment.authControl.read().publications).toBe(before);
    await environment.settings.update(
      principal(),
      { ...current, acknowledgeRestart: false },
      true,
      await organizationCredential(environment, principal()),
    );
    expect((await environment.settings.read(principal())).activation.state).toBe("active");
  });

  it("orders overlapping saves from separate hosted request instances", async () => {
    const current = await input();

    if (!current.sso) throw new Error("Expected configured identity");
    const gate = new EventEmitter();
    const paused = once(gate, "paused");
    const published: { clientId: string; secret: string }[] = [];

    const signIn = {
      callbackUrl: "https://auth.apps.localhost/oauth2/widefleet/callback",
      plan: () => Promise.resolve({ restartRequired: false, message: "Fixture" }),
      status: () =>
        Promise.resolve({
          revision: published.at(-1)?.clientId ?? "",
          state: "active",
          message: "Fixture",
        }),
      revision: (identity) => Promise.resolve(identity.management.clientId),
      publish: async (identity, secret) => {
        if (identity.management.clientId === "older-client") {
          const resumed = once(gate, "resume");
          gate.emit("paused");
          await resumed;
        }

        published.push({ clientId: identity.management.clientId, secret });

        return identity.management.clientId;
      },
    } satisfies AppSignIn;

    const service = () =>
      createSettingsService(
        environment.configuration,
        environment.database.db,
        environment.environment.PLATFORM_ENCRYPTION_KEY,
        () => signIn,
      );

    const change = (clientId: string, secret: string) =>
      settingsInput.parse({
        ...current,
        sso: {
          ...current.sso,
          oidcConfig: { ...current.sso?.oidcConfig, clientId, clientSecret: secret },
        },
      });

    const older = service().initialize(
      change("older-client", "older-secret"),
      "widefleet",
      await organizationCredential(environment, principal()),
    );

    await paused;

    const newer = service().initialize(
      change("newer-client", "newer-secret"),
      "widefleet",
      await organizationCredential(environment, principal()),
    );

    try {
      // Wait until the second request has either reached the database lock or
      // published out of order. Avoid relying on an arbitrary scheduling delay.
      await vi.waitFor(async () => {
        const blocked = await environment.database.db.execute(sql`
          select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
        `);

        expect(
          blocked.rows.length > 0 || published.some(({ clientId }) => clientId === "newer-client"),
        ).toBe(true);
      });
    } finally {
      gate.emit("resume");
      await Promise.all([older, newer]);
    }

    expect(published).toEqual([
      { clientId: "older-client", secret: "older-secret" },
      { clientId: "newer-client", secret: "newer-secret" },
    ]);
    expect((await environment.settings.resolve()).identity?.management.clientId).toBe(
      "newer-client",
    );
  });

  it("shows waiting when the saved provider still needs verification", async () => {
    await environment.database.db.update(ssoProvider).set({ domainVerified: false });

    try {
      expect((await environment.settings.read(principal())).activation).toMatchObject({
        state: "waiting",
        revision: "",
      });
    } finally {
      await environment.database.db.update(ssoProvider).set({ domainVerified: true });
    }
  });

  it("completes concurrent native saves without holding outer transaction connections", async () => {
    const saved = await input();
    const credential = await organizationCredential(environment, principal());
    await Promise.all(
      Array.from({ length: 12 }, () =>
        environment.settings.update(
          principal(),
          { ...saved, acknowledgeRestart: false },
          false,
          credential,
        ),
      ),
    );
    expect((await environment.settings.read(principal())).sso).toMatchObject(saved.sso ?? {});
  });

  it("lets a second settings read finish while an earlier read is still preparing its app status", async () => {
    const gate = new EventEmitter();
    const entered = once(gate, "entered");
    let reads = 0;

    const signIn: AppSignIn = {
      callbackUrl: "https://auth.apps.localhost/oauth2/widefleet/callback",
      plan: () => Promise.resolve({ restartRequired: false, message: "Fixture" }),
      publish: () => {
        throw new Error("A read must not publish");
      },
      revision: async () => {
        if (reads++ === 0) {
          const resumed = once(gate, "resume");
          gate.emit("entered");
          await resumed;
        }

        return "fixture-revision";
      },
      status: (revision) => Promise.resolve({ revision, state: "active", message: "Fixture" }),
    };

    const service = createSettingsService(
      environment.configuration,
      environment.database.db,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      () => signIn,
    );

    const first = service.inspect();
    await entered;
    let completed = false;

    const second = service.inspect().then((view) => {
      completed = true;

      return view;
    });

    try {
      await vi.waitFor(() => expect(completed).toBe(true));
    } finally {
      gate.emit("resume");
      await Promise.all([first, second]);
    }

    expect((await second).activation.state).toBe("active");
  });

  it("compares app status with each reader's own expected revision", async () => {
    const current = await input();

    if (!current.sso) throw new Error("Expected configured identity");
    let installed = "";

    const service = createInstalledAppSignIn(
      environment.configuration,
      Buffer.alloc(32, 1).toString("base64url"),
      (method) => {
        expect(method).toBe("GET");

        return Promise.resolve(
          Response.json({ revision: installed, state: "active", message: "Fixture" }),
        );
      },
      "immediate",
    );

    const resolved = await environment.settings.resolve();

    if (!resolved.identity) throw new Error("Missing published identity");
    const original = await service.revision(resolved.identity, "original-secret");
    const changed = await service.revision(resolved.identity, "changed-secret");
    installed = changed;
    const [older, newer] = await Promise.all([service.status(original), service.status(changed)]);
    expect(older).toMatchObject({ revision: original, state: "failed" });
    expect(newer).toMatchObject({ revision: changed, state: "active" });
  });

  it("renews active normal sessions after the refresh interval", async () => {
    const auth = createAuthentication(environment.configuration, environment.database.db);
    const loggedIn = await environment.users.login({ userId: environment.owner.id });
    const headers = new Headers(loggedIn.headers);
    const current = await auth.api.getSession({ headers });

    if (!current) throw new Error("Expected owner session");
    const previousExpiry = new Date(Date.now() + 7 * 60 * 60 * 1000);
    await environment.database.db
      .update(session)
      .set({ expiresAt: previousExpiry })
      .where(eq(session.id, current.session.id));

    const refreshed = await auth.api.getSession({ headers });
    expect(refreshed?.session.recovery).toBe(false);
    expect(refreshed?.session.expiresAt.getTime()).toBeGreaterThan(previousExpiry.getTime());

    const [stored] = await environment.database.db
      .select()
      .from(session)
      .where(eq(session.id, current.session.id));

    expect(stored?.expiresAt).toEqual(refreshed?.session.expiresAt);
  });

  it("requires a login with current SSO settings before closing password access and local sessions", async () => {
    const auth = createAuthentication(
      { ...environment.configuration, LOCAL_PASSWORD_ENABLED: true },
      environment.database.db,
    );

    const loggedIn = await environment.users.login({ userId: environment.owner.id });
    const headers = new Headers(loggedIn.headers);
    await expect(environment.settings.complete(principal(), auth, headers)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const current = await auth.api.getSession({ headers });

    if (!current) throw new Error("Expected owner session");
    await environment.database.db
      .update(session)
      .set({ companyConfiguration: "stale-configuration" })
      .where(eq(session.id, current.session.id));
    await expect(environment.settings.complete(principal(), auth, headers)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const resolved = await environment.settings.resolve();

    const proof = companyLoginRevision(resolved.sso);

    await environment.database.db
      .update(session)
      .set({ companyConfiguration: proof })
      .where(eq(session.id, current.session.id));
    await environment.settings.complete(principal(), auth, headers);
    expect((await readInstallation(environment.database.db)).localPasswordEnabled).toBe(false);
    expect(
      await environment.database.db
        .select()
        .from(session)
        .where(eq(session.companyConfiguration, "")),
    ).toHaveLength(0);

    const closedAuth = createAuthentication(
      { ...environment.configuration, LOCAL_PASSWORD_ENABLED: false },
      environment.database.db,
    );

    await expect(
      closedAuth.api.signInEmail({
        body: { email: environment.owner.email, password: "first-owner-password" },
      }),
    ).rejects.toBeDefined();
  });

  it("provides a single-use recovery link with a fixed short session and no password reopening", async () => {
    const auth = createAuthentication(
      { ...environment.configuration, LOCAL_PASSWORD_ENABLED: false },
      environment.database.db,
    );

    const url = new URL(
      await createRecoveryLink(
        auth,
        environment.database.db,
        environment.configuration,
        environment.owner.email,
      ),
    );

    expect(url.search).toBe("");
    const token = new URLSearchParams(url.hash.slice(1)).get("token");

    if (!token) throw new Error("Expected recovery token");

    const [created] = await environment.database.db
      .select()
      .from(session)
      .where(eq(session.recovery, true));

    if (!created) throw new Error("Expected recovery session before verification");
    const response = await auth.api.verifyOneTimeToken({ body: { token }, asResponse: true });
    expect(response.status).toBe(200);

    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");

    const headers = new Headers({ cookie, origin: environment.configuration.PLATFORM_URL });
    const current = await auth.api.getSession({ headers });
    expect(current?.session.recovery).toBe(true);

    if (!current) throw new Error("Expected recovery session");
    expect(current.session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600_000);
    expect(current.session.expiresAt).toEqual(created.expiresAt);

    const revisited = await auth.api.getSession({ headers, query: { disableRefresh: false } });
    expect(revisited?.session.expiresAt).toEqual(created.expiresAt);

    const [stored] = await environment.database.db
      .select()
      .from(session)
      .where(eq(session.id, created.id));

    expect(stored?.expiresAt).toEqual(created.expiresAt);
    await expect(auth.api.verifyOneTimeToken({ body: { token } })).rejects.toBeDefined();

    const approved = await auth.handler(
      new Request(`${environment.configuration.PLATFORM_URL}/api/auth/device/approve`, {
        method: "POST",
        headers: new Headers({
          cookie,
          origin: environment.configuration.PLATFORM_URL,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ userCode: "TEST-CODE" }),
      }),
    );

    expect(approved.status).toBe(403);
    await environment.database.db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(session.id, current.session.id));

    const identity = createIdentityService(
      auth,
      environment.database.db,
      environment.configuration,
    );

    expect(
      (
        await identity.authenticate(
          new Request(environment.configuration.PLATFORM_URL, { headers }),
          "platform:write",
        )
      ).isErr(),
    ).toBe(true);
    expect((await readInstallation(environment.database.db)).localPasswordEnabled).toBe(false);
  });
  it("imports bootstrap settings once and preserves later API changes across startup", async () => {
    const bootstrap = join(environment.configuration.PLATFORM_STATE_DIRECTORY, "bootstrap.json");
    await environment.database.db
      .update(installation)
      .set({ ownerId: null, localPasswordEnabled: true })
      .where(eq(installation.id, installationId));
    const settings = await input();

    if (!settings.sso) throw new Error("Missing fixture provider");
    settings.sso.oidcConfig.clientSecret = "bootstrap-fixture-secret";
    await environment.database.db.delete(ssoProvider);
    await writeFile(
      bootstrap,
      JSON.stringify({
        owner: {
          name: "Automation Owner",
          email: "automation@example.test",
          password: "bootstrap-password-only",
        },
        settings,
      }),
    );
    const configuration = { ...environment.configuration, PLATFORM_BOOTSTRAP_FILE: bootstrap };
    const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
    const initialized = await initializeRuntime(configuration, migrations);

    try {
      expect((await readInstallation(initialized.database.db)).ownerId).not.toBeNull();
      await initialized.settings.setExternalManagement(principal(), true);
    } finally {
      await initialized.database.close();
    }

    // A stale or removed bootstrap source must not overwrite live settings or block startup.
    await writeFile(bootstrap, "not JSON anymore");
    const restarted = await initializeRuntime(configuration, migrations);

    try {
      expect((await readInstallation(restarted.database.db)).settings.externallyManaged).toBe(true);
    } finally {
      await restarted.database.close();
    }
  });
});
