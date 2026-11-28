import { z } from "zod";
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { installationSettings, settingsView, domainVerification } from "@platform/contracts";
import { ssoProvider } from "../../src/lib/server/auth-schema.ts";
import { installation, organizationSettings } from "../../src/lib/server/schema.ts";
import { installationId } from "../../src/lib/server/installation-store.ts";
import { createTestEnvironment } from "../environment.ts";

test("verifies company DNS and enforces company SSO", async ({ page, request }) => {
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
        // Keep the saved usage opt-out effective without an environment override.
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
    await page.getByLabel("Your name", { exact: true }).fill("IT Admin");
    await page.getByLabel("Organization name", { exact: true }).fill("Example Team");
    await page.getByLabel("Email", { exact: true }).fill("sso@example.test");
    environment.authControl.available(false);
    await page.getByRole("button", { name: "Create account and continue" }).click();
    await expect(page).toHaveURL(/\/sign-in\?/);
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("sso@example.test");
    await page.getByRole("button", { name: "Continue with email", exact: true }).click();
    await expect.poll(() => logs.match(/code is (\d{6})/)?.[1]).toBeTruthy();
    const otp = z.string().parse(logs.match(/code is (\d{6})/)?.[1]);
    await page.getByLabel("Sign-in code", { exact: true }).fill(otp);
    await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/company-sign-in$/);
    await expect(page.getByRole("button", { name: "Activate Widefleet sign-in" })).toBeVisible();
    environment.authControl.available(true);
    await page.getByRole("button", { name: "Activate Widefleet sign-in" }).click();
    await expect(page.getByText("Widefleet app sign-in is active.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy", exact: true })).toHaveCount(0);
    await page.goto("/widefleet/settings?section=reporting");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/settings\/company-sign-in\?section=reporting$/);
    await expect(page.getByRole("link", { name: "Company sign-in", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const reporting = await page.request.get("/api/v1/reporting");
    expect(reporting.ok()).toBe(true);
    expect(await reporting.json()).toMatchObject({
      preferences: { usage: false },
      effective: { usage: false, crashes: false },
    });
    await page.getByRole("link", { name: "Set up company SSO", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/company-sign-in\/setup$/);
    await page.getByRole("button", { name: /^Microsoft Entra/ }).click();
    await expect(page.getByRole("heading", { name: "Register Widefleet" })).toBeVisible();
    await expect(
      page.getByText("http://localhost:25430/api/auth/sso/callback/company-widefleet", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("https://auth.apps.localhost/oauth2/widefleet/callback", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByLabel("Issuer URL")
      .fill(
        `${environment.environment.ENTRA_AUTHORITY}/${environment.environment.ENTRA_TENANT_ID}/v2.0`,
      );
    await page.getByLabel("Company email domain").fill("example.test");
    await page
      .getByLabel("Client ID", { exact: true })
      .fill(environment.environment.ENTRA_CLIENT_ID);
    await page
      .getByLabel("Client secret", { exact: true })
      .fill(environment.environment.ENTRA_CLIENT_SECRET);
    await page.getByRole("button", { name: "Save and continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Verify email domain" })).toBeVisible();

    const initial = environment.authControl.read();

    const recordResponse = await page.request.post("/api/v1/settings/domain-verification", {
      headers: { origin: environment.configuration.PLATFORM_URL },
    });

    expect(recordResponse.ok()).toBe(true);
    const record = domainVerification.parse(await recordResponse.json());
    await expect(page.getByText(record.name, { exact: true })).toBeVisible();
    await expect(page.getByText(record.value, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Verify example.test", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("No matching TXT record");
    await writeFile(dnsFile, JSON.stringify({ [record.name]: record.value }));
    await page.getByRole("button", { name: "Verify example.test", exact: true }).click();
    await expect(page.getByText("example.test is verified.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Test company sign-in" }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(
      page.getByText("Company sign-in and administrator access verified successfully."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Activate company SSO" }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(page).toHaveURL(/\/settings\/company-sign-in$/);
    await expect(page.getByText("Required for all members", { exact: false })).toBeVisible();
    await page.goto("/widefleet/settings/company-sign-in");
    await page.waitForLoadState("networkidle");

    const passwordLogin = await request.post("/api/auth/sign-in/email", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { email: "sso@example.test", password: "setup-password-for-browser-test" },
    });

    expect(passwordLogin.status()).toBe(404);
    await page.goto("/widefleet/settings/administration");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Manage settings externally" }).click();
    await page.goto("/widefleet/settings/company-sign-in");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Edit configuration" })).toBeDisabled();
    await page.goto("/widefleet/settings/administration");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Enable browser editing" }).click();
    await page.goto("/widefleet/settings/company-sign-in");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Edit configuration" }).click();
    await expect(page).toHaveURL(/\/settings\/company-sign-in\?edit$/);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Client secret", { exact: true }).fill("rotated-secret");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The HTTP publication is acknowledged before the settings save completes.
    await expect(page.getByRole("heading", { name: "Connection" })).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Connection" })).toBeVisible();
    environment.authControl.available(true);
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
