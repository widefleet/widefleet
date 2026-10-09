import { expect, test } from "@playwright/test";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { installationSettings, settingsView } from "@platform/contracts";
import { authBundle } from "../../src/lib/server/auth-bundle.ts";
import { account } from "../../src/lib/server/auth-schema.ts";
import { installation } from "../../src/lib/server/schema.ts";
import { installationId } from "../../src/lib/server/installation-store.ts";
import { createRecoveryLink } from "../../src/lib/server/recovery.ts";
import { createTestEnvironment } from "../environment.ts";

test("sets up an administrator, links and verifies company SSO, then closes password access", async ({
  page,
  request,
}) => {
  const environment = await createTestEnvironment();
  await environment.database.db
    .update(installation)
    .set({ ownerId: null, settings: installationSettings.parse({}), usageReporting: false })
    .where(eq(installation.id, installationId));

  const server = spawn(process.execPath, ["build"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...process.env,
      ...environment.environment,
      // Exercise editable preferences while keeping all reporting disabled.
      PLATFORM_USAGE_REPORTING: undefined,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "25430",
      PROTOCOL_HEADER: "x-forwarded-proto",
      SHUTDOWN_TIMEOUT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

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
    await page.getByLabel("Email", { exact: true }).fill("it-admin@example.test");
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
    await page.getByLabel("Directory ID (tenant ID)").fill(environment.environment.ENTRA_TENANT_ID);
    await page.getByText("Advanced provider settings", { exact: true }).click();
    await page
      .getByLabel("Authority", { exact: true })
      .fill(environment.environment.ENTRA_AUTHORITY);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByText("http://localhost:25430/api/auth/callback/microsoft", { exact: true }),
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
    // The browser fixture has no proxy process; represent the supervisor's acknowledged configuration.
    await copyFile(
      join(environment.configuration.PLATFORM_AUTH_DIRECTORY, "desired.json"),
      join(environment.configuration.PLATFORM_AUTH_DIRECTORY, "active.json"),
    );
    await page.getByRole("button", { name: "Link company account" }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(page.getByRole("button", { name: "Test company sign-in" })).toBeVisible();
    await page.getByRole("button", { name: "Test company sign-in" }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(
      page.getByText("Company sign-in and administrator access verified successfully."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Complete setup and disable password access" }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

    const passwordLogin = await request.post("/api/auth/sign-in/email", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { email: "it-admin@example.test", password: "setup-password-for-browser-test" },
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
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save and restart" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeFocused();
    // Once setup is complete, activation feedback must remain visible beside the editor.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Save and restart" }).click();
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Client ID", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Activating configuration" }),
    ).toBeVisible();

    const desired = authBundle.parse(
      JSON.parse(
        await readFile(
          join(environment.configuration.PLATFORM_AUTH_DIRECTORY, "desired.json"),
          "utf8",
        ),
      ),
    );

    await writeFile(
      join(environment.configuration.PLATFORM_AUTH_DIRECTORY, "status.json"),
      JSON.stringify({
        revision: desired.revision,
        state: "failed",
        message:
          "The identity provider's TLS certificate is not trusted. Check the SSO container's CA certificates and the provider's certificate chain.",
      }),
      { mode: 0o600 },
    );
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "The identity provider's TLS certificate is not trusted." }),
    ).toBeVisible({ timeout: 8000 });
    const settingsResponse = await page.request.get("/api/v1/settings");
    expect(settingsResponse.ok()).toBe(true);
    expect(settingsView.parse(await settingsResponse.json()).activation.message).toContain(
      "The identity provider's TLS certificate is not trusted.",
    );
    await expect(page.getByLabel("Client ID", { exact: true })).toBeVisible();

    const link = await createRecoveryLink(
      environment.auth,
      environment.database.db,
      environment.configuration,
      "it-admin@example.test",
    );

    await page.goto(link);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

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
    await page.getByRole("button", { name: "Save and restart" }).click();
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Sign-in settings" })
      .getByRole("button", { name: "Company account", exact: false })
      .click();
    await page.getByRole("button", { name: "Link another company account" }).click();
    await page.getByRole("button", { name: /foreign@example.test/ }).click();
    await page.getByRole("button", { name: "Test company sign-in" }).click();
    await page.getByRole("button", { name: /foreign@example.test/ }).click();
    await expect(
      page.getByText("Company sign-in and administrator access verified successfully."),
    ).toBeVisible();

    const linkedAccounts = await environment.database.db
      .select()
      .from(account)
      .where(eq(account.providerId, "microsoft"));

    expect(linkedAccounts).toHaveLength(2);
    expect(new Set(linkedAccounts.map((entry) => entry.userId)).size).toBe(1);
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
