import { z } from "zod";
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
import { migrateSsoSettings } from "../../src/lib/server/sso-migration.ts";
import { encryptSecret } from "../../src/lib/server/secret-encryption.ts";
import { createRecoveryLink } from "../../src/lib/server/recovery.ts";
import { createTestEnvironment } from "../environment.ts";

test("verifies company DNS, preserves matching accounts and enforces company SSO", async ({
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
    .set({ settings: installationSettings.parse({}), ssoRequired: false })
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
        LOGIN_CODE_DELIVERY: "console",
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
    await page.getByLabel("Organization name", { exact: true }).fill("Example Team");
    await page.getByLabel("Email", { exact: true }).fill("sso@example.test");
    environment.authControl.available(false);
    await page.getByRole("button", { name: "Create account and continue" }).click();
    await expect(page).toHaveURL(/\/sign-in\?/);
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("sso@example.test");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(() => logs.match(/code is (\d{6})/)?.[1]).toBeTruthy();
    const otp = z.string().parse(logs.match(/code is (\d{6})/)?.[1]);
    await page.getByLabel("Sign-in code", { exact: true }).fill(otp);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("button", { name: "Activate Widefleet sign-in" })).toBeVisible();
    environment.authControl.available(true);
    await page.getByRole("button", { name: "Activate Widefleet sign-in" }).click();
    await expect(page.getByText("Widefleet app sign-in is active.", { exact: true })).toBeVisible();
    await page.goto("/welcome");
    await expect(page.getByRole("heading", { name: "Publish your first app" })).toBeVisible();
    await page.getByRole("link", { name: "Organization settings", exact: true }).click();
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
    await page.getByRole("button", { name: "Configure company SSO", exact: true }).click();
    await page.getByLabel("Company email domain").fill("example.test");
    await page
      .getByLabel("Issuer URL")
      .fill(
        `${environment.environment.ENTRA_AUTHORITY}/${environment.environment.ENTRA_TENANT_ID}/v2.0`,
      );
    await page.getByLabel("App identity claims").selectOption("entra");
    await expect(
      page.getByText("http://localhost:25430/api/auth/sso/callback/company-widefleet", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("https://auth.apps.localhost/oauth2/widefleet/callback", { exact: true }),
    ).toBeVisible();
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
    await page.getByRole("button", { name: "Verify domain", exact: true }).click();
    await page.getByRole("button", { name: "Test company sign-in" }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(
      page.getByText("Company sign-in and administrator access verified successfully."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Activate company SSO" }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(page).toHaveURL(/\/settings(?:\?|$)/);
    await expect(page.getByRole("button", { name: "Activate company SSO" })).toHaveCount(0);

    const passwordLogin = await request.post("/api/auth/sign-in/email", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { email: "sso@example.test", password: "setup-password-for-browser-test" },
    });

    expect(passwordLogin.status()).toBe(404);
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Administration", exact: true })
      .click();
    await page.getByRole("button", { name: "Manage settings externally" }).click();
    await page.getByRole("link", { name: "Company sign-in", exact: true }).click();
    await expect(page.getByLabel("Client ID", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Administration", exact: true })
      .click();
    await page.getByRole("button", { name: "Enable browser editing" }).click();
    await page.getByRole("link", { name: "Company sign-in", exact: true }).click();
    await page.getByLabel("Client secret", { exact: true }).fill("rotated-secret");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The HTTP publication is acknowledged before the settings save completes.
    await expect(page.getByLabel("Client ID", { exact: true })).toBeVisible();
    await expect(
      page.getByText("The sign-in configuration is published.", {
        exact: true,
      }),
    ).toBeVisible();

    const desired = environment.authControl.read();
    expect(desired.configuration?.clientId).toBe(environment.environment.ENTRA_CLIENT_ID);
    expect(desired.configuration?.clientSecret).toBe("rotated-secret");
    expect(desired.revision).not.toBe(initial.revision);
    environment.authControl.available(false);
    await page.reload();
    await expect(
      page.getByText(
        "The auth proxy is unavailable. Check the service and save the settings again.",
        { exact: true },
      ),
    ).toBeVisible();
    const settingsResponse = await page.request.get("/api/v1/settings");
    expect(settingsResponse.ok()).toBe(true);
    expect(settingsView.parse(await settingsResponse.json()).activation.state).toBe("failed");
    await expect(page.getByLabel("Client ID", { exact: true })).toBeVisible();
    environment.authControl.available(true);

    // Model the state preserved by migration 0023: saved encrypted credentials,
    // an existing owner, no company-domain proof and no native SSO provider yet.
    const [beforeUpgrade] = await environment.database.db
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, installationId));

    const preserved = installationSettings.parse(beforeUpgrade?.settings);

    const managementSecret = {
      ciphertext: await encryptSecret(
        environment.environment.PLATFORM_ENCRYPTION_KEY,
        environment.environment.ENTRA_CLIENT_SECRET,
      ),
    };

    await environment.database.db
      .update(organizationSettings)
      .set({
        ssoRequired: false,
        settings: {
          externallyManaged: preserved.externallyManaged,
          identity: {
            provider: environment.configuration.IDENTITY.provider,
            domain: null,
            management: {
              clientId: environment.environment.ENTRA_CLIENT_ID,
              secret: managementSecret,
            },
            directory: null,
          },
        },
      })
      .where(eq(organizationSettings.organizationId, installationId));
    await environment.database.db.delete(ssoProvider);
    await migrateSsoSettings(
      environment.database.db,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
    );
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

    await expect(page.getByLabel("Organization slug")).toHaveCount(0);
    await page.goto(link);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.getByLabel("Company email domain").fill("example.test");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Get verification record" }).click();

    const upgradeRecordResponse = await page.request.post("/api/v1/settings/domain-verification", {
      headers: { origin: environment.configuration.PLATFORM_URL },
    });

    expect(upgradeRecordResponse.ok()).toBe(true);
    const upgradeRecord = domainVerification.parse(await upgradeRecordResponse.json());
    await writeFile(dnsFile, JSON.stringify({ [upgradeRecord.name]: upgradeRecord.value }));
    await page.getByRole("button", { name: "Verify domain", exact: true }).click();
    await page.getByRole("button", { name: "Test company sign-in" }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(
      page.getByText("Company sign-in and administrator access verified successfully."),
    ).toBeVisible();
    expect((await page.request.get("/api/v1/settings")).status()).toBe(200);

    const [afterUpgrade] = await environment.database.db
      .select()
      .from(installation)
      .where(eq(installation.id, installationId));

    expect(
      settingsView.parse(await (await page.request.get("/api/v1/settings")).json()).ssoRequired,
    ).toBe(false);

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
      .getByLabel("Issuer URL")
      .fill(
        `${environment.environment.ENTRA_AUTHORITY}/${environment.replacementClient.tenantId}/v2.0`,
      );
    await page
      .getByLabel("Client ID", { exact: true })
      .fill(environment.replacementClient.clientId);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    const [provider] = await environment.database.db.select().from(ssoProvider);
    expect(provider?.issuer).toContain(environment.environment.ENTRA_TENANT_ID);

    const linkedAccounts = await environment.database.db
      .select()
      .from(account)
      .where(eq(account.providerId, "microsoft"));

    expect(linkedAccounts).toHaveLength(1);
    expect(linkedAccounts[0]?.userId).toBe(afterUpgrade?.ownerId);
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
