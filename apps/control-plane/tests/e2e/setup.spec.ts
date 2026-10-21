import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { installationSettings, settingsView, domainVerification } from "@platform/contracts";
import { account, ssoProvider } from "../../src/lib/server/auth-schema.ts";
import { installation, organizationSettings } from "../../src/lib/server/schema.ts";
import { installationId } from "../../src/lib/server/installation-store.ts";
import { createOrganizationSecrets } from "../../src/lib/server/organization-secrets.ts";
import { createRecoveryLink } from "../../src/lib/server/recovery.ts";
import { createTestEnvironment } from "../environment.ts";

test("verifies company DNS, preserves matching accounts and closes password access", async ({
  page,
  request,
}) => {
  const environment = await createTestEnvironment();
  await environment.database.db
    .update(installation)
    .set({ ownerId: null, usageReporting: false })
    .where(eq(installation.id, installationId));

  await environment.database.db
    .update(organizationSettings)
    .set({ settings: installationSettings.parse({}) })
    .where(eq(organizationSettings.organizationId, installationId));

  await environment.database.db.delete(ssoProvider);
  const dnsFile = join(environment.environment.PLATFORM_STATE_DIRECTORY, "dns.json");
  await writeFile(dnsFile, "{}");

  const server = spawn(
    process.execPath,
    ["--import", fileURLToPath(new URL("./dns.fixture.ts", import.meta.url)), "build"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        ...environment.environment,
        WIDEFLEET_TEST_DNS_FILE: dnsFile,
        // Exercise editable preferences while keeping all reporting disabled.
        PLATFORM_USAGE_REPORTING: undefined,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "25430",
        PROTOCOL_HEADER: "x-forwarded-proto",
        SHUTDOWN_TIMEOUT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  server.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    logs += chunk;
  });
  server.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    logs += chunk;
  });

  try {
    await expect
      .poll(
        async () => {
          if (server.exitCode !== null) throw new Error(logs);

          try {
            return (await fetch(`${environment.configuration.PLATFORM_URL}/healthz`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel("Name", { exact: true }).fill("IT Admin");
    await page.getByLabel("Email", { exact: true }).fill("sso@example.test");
    await page.getByLabel("Password", { exact: true }).fill("setup-password-for-browser-test");
    await page.getByRole("button", { name: "Create account and continue" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByRole("link", { name: "Privacy", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Improve Widefleet" })).toBeVisible();
    await expect(page.getByLabel("Share usage and configuration")).toBeEnabled();
    await expect(page.getByLabel("Share usage and configuration")).not.toBeChecked();
    await expect(page.getByLabel("Share error reports")).not.toBeChecked();
    await expect(page.getByLabel("Share error reports")).toBeDisabled();
    await page.getByRole("button", { name: "Save telemetry settings" }).click();
    await expect(page.getByText("Telemetry settings saved.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Share usage and configuration")).not.toBeChecked();
    await page.getByRole("button", { name: "View usage report" }).click();
    await expect(page.getByRole("textbox", { name: "Usage report preview" })).toHaveValue(
      /installation_snapshot/,
    );
    await page.getByRole("link", { name: "Company sign-in", exact: true }).click();
    await page.getByLabel("Company email domain").fill("example.test");
    await page.getByLabel("Directory ID (tenant ID)").fill(environment.environment.ENTRA_TENANT_ID);
    await page.getByText("Advanced provider settings", { exact: true }).click();
    await page
      .getByLabel("Authority", { exact: true })
      .fill(environment.environment.ENTRA_AUTHORITY);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByText("http://localhost:25430/api/auth/sso/callback/microsoft", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Client ID", { exact: true })
      .fill(environment.environment.ENTRA_CLIENT_ID);
    await page
      .getByLabel("Client secret", { exact: true })
      .fill(environment.environment.ENTRA_CLIENT_SECRET);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByLabel("Directory ID (tenant ID)")).toHaveValue(
      environment.environment.ENTRA_TENANT_ID,
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByLabel("Client ID", { exact: true })).toHaveValue(
      environment.environment.ENTRA_CLIENT_ID,
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByLabel("Client ID", { exact: true })
      .fill(environment.environment.ENTRA_CLIENT_ID);
    await page
      .getByLabel("Client secret", { exact: true })
      .fill(environment.environment.ENTRA_CLIENT_SECRET);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();

    const initial = environment.authControl.read();

    await page.getByRole("button", { name: "Get verification record" }).click();

    const recordResponse = await page.request.post("/api/v1/settings/domain-verification", {
      headers: { origin: environment.configuration.PLATFORM_URL },
    });

    expect(recordResponse.ok()).toBe(true);
    const record = domainVerification.parse(await recordResponse.json());
    await expect(page.getByText(record.value, { exact: true })).toBeVisible();
    await writeFile(dnsFile, JSON.stringify({ [record.name]: record.value }));
    await page.getByRole("button", { name: "Verify domain and sign in" }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(
      page.getByText("Company sign-in and administrator access verified successfully."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Complete setup and disable password access" }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

    const passwordLogin = await request.post("/api/auth/sign-in/email", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { email: "sso@example.test", password: "setup-password-for-browser-test" },
    });

    expect(passwordLogin.status()).toBeGreaterThanOrEqual(400);
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Administration", exact: true })
      .click();
    await page.getByRole("button", { name: "Manage settings externally" }).click();
    await page.getByRole("link", { name: "Company sign-in", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Sign-in settings" })
      .getByRole("button", { name: "Administration", exact: false })
      .click();
    await expect(page.getByLabel("Client ID", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Manage editing" }).click();
    await page.getByRole("button", { name: "Enable browser editing" }).click();
    await page.getByRole("link", { name: "Company sign-in", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Sign-in settings" })
      .getByRole("button", { name: "App sign-in", exact: false })
      .click();
    await page.getByLabel("Client ID", { exact: true }).fill("replacement-client");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The HTTP publication is acknowledged before the settings save completes.
    await expect(page.getByLabel("Client ID", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "The sign-in service is running with the saved configuration." }),
    ).toBeVisible();

    const desired = environment.authControl.read();
    expect(desired.configuration?.clientId).toBe("replacement-client");
    expect(desired.revision).not.toBe(initial.revision);
    environment.authControl.available(false);
    await page.reload();
    await expect(
      page.getByRole("status").filter({ hasText: "The auth proxy is unavailable." }),
    ).toBeVisible();
    const settingsResponse = await page.request.get("/api/v1/settings");
    expect(settingsResponse.ok()).toBe(true);
    expect(settingsView.parse(await settingsResponse.json()).activation.state).toBe("failed");
    await page
      .getByRole("navigation", { name: "Sign-in settings" })
      .getByRole("button", { name: "App sign-in", exact: false })
      .click();
    await expect(page.getByLabel("Client ID", { exact: true })).toBeVisible();
    environment.authControl.available(true);

    // Model the state preserved by migration 0022: saved encrypted credentials,
    // an existing owner, no company-domain proof and no native SSO provider yet.
    const [beforeUpgrade] = await environment.database.db
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, installationId));

    const preserved = installationSettings.parse(beforeUpgrade?.settings);

    if (!preserved.identity) throw new Error("Missing saved company settings");

    const secrets = createOrganizationSecrets(
      environment.database.db,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      installationId,
    );

    const managementSecret = await secrets.save(environment.database.db, {
      type: "value",
      value: environment.environment.ENTRA_CLIENT_SECRET,
    });

    await environment.database.db
      .update(organizationSettings)
      .set({
        settings: {
          ...preserved,
          identity: {
            ...preserved.identity,
            domain: null,
            management: { ...preserved.identity.management, secret: managementSecret },
          },
        },
      })
      .where(eq(organizationSettings.organizationId, installationId));
    await environment.database.db.delete(ssoProvider);
    await page.context().clearCookies();
    await page.goto("/sign-in");
    await expect(page.getByRole("button", { name: "Sign in with Microsoft" })).toHaveCount(0);
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);

    const link = await createRecoveryLink(
      environment.auth,
      environment.database.db,
      environment.configuration,
      "sso@example.test",
    );

    await page.goto(link);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Sign-in settings" })
      .getByRole("button", { name: "Provider", exact: false })
      .click();
    await page.getByLabel("Company email domain").fill("example.test");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Sign-in settings" })
      .getByRole("button", { name: "Company account", exact: false })
      .click();
    await page.getByRole("button", { name: "Get verification record" }).click();

    const upgradeRecordResponse = await page.request.post("/api/v1/settings/domain-verification", {
      headers: { origin: environment.configuration.PLATFORM_URL },
    });

    expect(upgradeRecordResponse.ok()).toBe(true);
    const upgradeRecord = domainVerification.parse(await upgradeRecordResponse.json());
    await writeFile(dnsFile, JSON.stringify({ [upgradeRecord.name]: upgradeRecord.value }));
    await page.getByRole("button", { name: "Verify domain and sign in" }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(
      page.getByText("Company sign-in and administrator access verified successfully."),
    ).toBeVisible();
    expect((await page.request.get("/api/v1/settings")).status()).toBe(200);

    const [afterUpgrade] = await environment.database.db
      .select()
      .from(installation)
      .where(eq(installation.id, installationId));

    expect(afterUpgrade?.localPasswordEnabled).toBe(false);

    const restored = await environment.auth.api.getSession({
      headers: new Headers({
        cookie: (await page.context().cookies())
          .map(({ name, value }) => `${name}=${value}`)
          .join("; "),
      }),
    });

    expect(restored?.user.id).toBe(afterUpgrade?.ownerId);

    const replacementLink = await createRecoveryLink(
      environment.auth,
      environment.database.db,
      environment.configuration,
      "sso@example.test",
    );

    await page.goto(replacementLink);
    await expect(page).toHaveURL(/\/settings$/);
    await page
      .getByRole("navigation", { name: "Sign-in settings" })
      .getByRole("button", { name: "Provider", exact: false })
      .click();
    await page.getByLabel("Directory ID (tenant ID)").fill(environment.replacementClient.tenantId);
    await page
      .getByRole("navigation", { name: "Sign-in settings" })
      .getByRole("button", { name: "Administration", exact: false })
      .click();
    await page
      .getByLabel("Client ID", { exact: true })
      .fill(environment.replacementClient.clientId);
    await page
      .getByRole("navigation", { name: "Sign-in settings" })
      .getByRole("button", { name: "App sign-in", exact: false })
      .click();
    await page
      .getByLabel("Client ID", { exact: true })
      .fill(environment.replacementClient.clientId);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Sign-in settings" })
      .getByRole("button", { name: "Company account", exact: false })
      .click();
    await page.getByRole("button", { name: "Get verification record" }).click();

    const changedRecordResponse = await page.request.post("/api/v1/settings/domain-verification", {
      headers: { origin: environment.configuration.PLATFORM_URL },
    });

    const changedRecord = domainVerification.parse(await changedRecordResponse.json());
    await writeFile(dnsFile, JSON.stringify({ [changedRecord.name]: changedRecord.value }));
    await page.getByRole("button", { name: "Verify domain and sign in" }).click();
    await page.getByRole("button", { name: /foreign@example.test/ }).click();
    await expect.poll(async () => (await page.request.get("/api/v1/settings")).status()).toBe(403);

    const linkedAccounts = await environment.database.db
      .select()
      .from(account)
      .where(eq(account.providerId, "microsoft"));

    expect(linkedAccounts).toHaveLength(1);

    const [installed] = await environment.database.db
      .select()
      .from(installation)
      .where(eq(installation.id, installationId));

    expect(linkedAccounts[0]?.userId).not.toBe(installed?.ownerId);
  } catch (cause) {
    await test.info().attach("setup-server-log", { body: logs, contentType: "text/plain" });
    throw cause;
  } finally {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
      server.kill("SIGTERM");
      await exited;
      clearTimeout(timeout);
    }

    await environment.close();
  }
});
