import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeRuntime } from "../src/lib/server/runtime.ts";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { copyFile, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installationSettings, settingsInput } from "@platform/contracts";
import { createAuthentication, companyLoginRevision } from "../src/lib/server/auth.ts";
import { member, session, user } from "../src/lib/server/auth-schema.ts";
import { installation, installationSecrets } from "../src/lib/server/schema.ts";
import {
  createInstallationOwner,
  installationId,
  readInstallation,
} from "../src/lib/server/installation-store.ts";
import { authBundle } from "../src/lib/server/auth-bundle.ts";
import { createRecoveryLink } from "../src/lib/server/recovery.ts";
import { createIdentityService } from "../src/lib/server/identity.ts";
import { createTestEnvironment } from "./environment.ts";

describe("Platform setup and managed settings", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => {
    await environment.close();
  });

  const principal = () => ({
    ...environment.owner,
    role: "owner" as const,
    admin: true,
    creator: true,
    company: undefined,
  });

  const input = async () =>
    settingsInput.parse((await environment.settings.read(principal())).settings);

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

    if (!current.identity) throw new Error("Expected configured identity");
    current.identity.management.secret = { type: "value", value: "private-management-secret" };

    const result = await environment.settings.update(
      principal(),
      { ...current, acknowledgeRestart: false },
      true,
    );

    expect(JSON.stringify(result)).not.toContain("private-management-secret");
    expect(result.settings.identity?.management.secret).toMatchObject({ type: "stored" });

    const reference = result.settings.identity?.management.secret;

    if (reference?.type !== "stored") throw new Error("Expected a stored secret reference");

    const [stored] = await environment.database.db
      .select()
      .from(installationSecrets)
      .where(eq(installationSecrets.id, reference.id));

    expect(stored?.ciphertext).not.toContain("private-management-secret");
    expect((await environment.settings.resolve()).identity?.management.clientSecret).toBe(
      "private-management-secret",
    );
    expect(() =>
      installationSettings.parse({ ...result.settings, identity: current.identity }),
    ).toThrow();
  });

  it("preserves other clients sharing a stored secret when one client replaces it", async () => {
    const current = await input();

    if (!current.identity) throw new Error("Expected configured identity");
    current.identity.apps.secret = current.identity.management.secret;
    await environment.settings.update(principal(), { ...current, acknowledgeRestart: false }, true);
    current.identity.management.secret = { type: "value", value: "replacement-management-secret" };

    const updated = await environment.settings.update(
      principal(),
      { ...current, acknowledgeRestart: false },
      true,
    );

    expect(updated.settings.identity?.management.secret).not.toEqual(
      updated.settings.identity?.apps.secret,
    );
    expect((await environment.settings.resolve()).identity?.management.clientSecret).toBe(
      "replacement-management-secret",
    );

    const bundle = authBundle.parse(
      JSON.parse(
        await readFile(
          join(environment.configuration.PLATFORM_AUTH_DIRECTORY, "desired.json"),
          "utf8",
        ),
      ),
    );

    expect(bundle.clientSecret).toBe("private-management-secret");
    expect(await environment.database.db.select().from(installationSecrets)).toHaveLength(2);
  });

  it("enforces administrator access and browser read-only while allowing API changes", async () => {
    const viewer = { ...principal(), role: "member" as const, admin: false };
    await expect(environment.settings.read(viewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await environment.settings.setExternalManagement(principal(), true);
    const current = await input();
    await expect(
      environment.settings.update(principal(), { ...current, acknowledgeRestart: false }, true),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      environment.settings.update(principal(), { ...current, acknowledgeRestart: false }, false),
    ).resolves.toMatchObject({ settings: { externallyManaged: true } });
    await environment.settings.setExternalManagement(principal(), false);
  });

  it("requires restart acknowledgement only for changes to proxy options", async () => {
    const current = await input();

    if (!current.identity) throw new Error("Expected configured identity");
    const directory = environment.configuration.PLATFORM_AUTH_DIRECTORY;
    await copyFile(join(directory, "desired.json"), join(directory, "active.json"));
    current.identity.apps.secret = { type: "value", value: "rotated-app-secret" };
    const original = structuredClone(current);
    expect(await environment.settings.plan(principal(), current)).toMatchObject({
      restartRequired: false,
    });
    current.identity.apps.clientId = "replacement-app-client";
    expect(await environment.settings.plan(principal(), current)).toMatchObject({
      restartRequired: true,
    });
    await expect(
      environment.settings.update(principal(), { ...current, acknowledgeRestart: false }, true),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await environment.settings.update(principal(), { ...current, acknowledgeRestart: true }, true);
    expect((await input()).identity?.apps.clientId).toBe("replacement-app-client");
    // Simulate a failed activation: the saved settings changed, but the active proxy did not.
    expect(await environment.settings.plan(principal(), await input())).toMatchObject({
      restartRequired: true,
    });
    expect(await environment.settings.plan(principal(), original)).toMatchObject({
      restartRequired: false,
    });
    await copyFile(join(directory, "desired.json"), join(directory, "active.json"));
    expect(await environment.settings.plan(principal(), await input())).toMatchObject({
      restartRequired: false,
    });
  });

  it("cannot overwrite a completed update with an older delayed publication", async () => {
    const current = await input();

    if (!current.identity) throw new Error("Expected configured identity");
    const directory = environment.configuration.PLATFORM_AUTH_DIRECTORY;
    const path = join(directory, "desired.json");
    await rm(path);
    await promisify(execFile)("mkfifo", [path]);
    // Pause the older publication at its existing-file read while another request
    // saves settings. No external secret source is involved.
    const older = environment.settings.resolve();
    const writer = await open(path, "w");

    try {
      current.identity.directory = null;
      current.identity.apps.secret = { type: "value", value: "replacement-app-secret" };
      current.identity.apps.clientId = "latest-client";

      const updated = environment.settings.update(
        principal(),
        { ...current, acknowledgeRestart: true },
        true,
      );

      await vi.waitFor(async () => {
        expect(
          (await readInstallation(environment.database.db)).settings.identity?.apps.clientId,
        ).toBe("latest-client");
      });
      await writer.writeFile("{}");
      await writer.close();
      const [previous] = await Promise.all([older, updated]);
      expect(previous.identity).not.toBeNull();
      expect(previous.error).toBeNull();

      const bundle = authBundle.parse(
        JSON.parse(await readFile(join(directory, "desired.json"), "utf8")),
      );

      expect(bundle).toHaveProperty("proxy.providers.0.clientID", "latest-client");
      await copyFile(join(directory, "desired.json"), join(directory, "active.json"));
    } finally {
      await writer.close();
      await older;
    }
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

    const proof = companyLoginRevision({
      ...environment.configuration,
      IDENTITY: resolved.identity,
    });

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
