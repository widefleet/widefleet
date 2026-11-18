import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ssoProvider } from "../../src/lib/server/auth-schema.ts";
import { organizationSettings } from "../../src/lib/server/schema.ts";
import { createTestEnvironment } from "../environment.ts";

test.use({ baseURL: "http://localhost:25435" });

test("configures self-hosted SSO without a company domain or DNS proof", async ({ page }) => {
  const environment = await createTestEnvironment("http://localhost:25435", undefined, {
    trustProvider: true,
    allowEmailAccountLinking: true,
  });

  await environment.database.db.delete(ssoProvider);
  await environment.database.db.update(organizationSettings).set({ ssoRequired: false });

  const server = spawn(process.execPath, ["build"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...process.env,
      ...environment.environment,
      LOGIN_CODE_DELIVERY: "console",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "25435",
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
        { timeout: 15000 },
      )
      .toBe(true);
    await page.goto("/sign-in?next=/settings");
    await page.getByLabel("Email", { exact: true }).fill(environment.owner.email);
    await page.getByRole("button", { name: "Continue with email", exact: true }).click();
    await expect.poll(() => logs.match(/code is (\d{6})/)?.[1]).toBeTruthy();
    await page
      .getByLabel("Sign-in code", { exact: true })
      .fill(z.string().parse(logs.match(/code is (\d{6})/)?.[1]));
    await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByRole("button", { name: "Configure company SSO", exact: true }).click();
    const domain = page.getByLabel("Company email domain (optional)");
    await expect(domain).not.toHaveAttribute("required");
    await page
      .getByLabel("Issuer URL")
      .fill(
        `${environment.environment.ENTRA_AUTHORITY}/${environment.environment.ENTRA_TENANT_ID}/v2.0`,
      );
    await page.getByLabel("App identity provider").selectOption("entra");
    await page
      .getByLabel("Client ID", { exact: true })
      .fill(environment.environment.ENTRA_CLIENT_ID);
    await page
      .getByLabel("Client secret", { exact: true })
      .fill(environment.environment.ENTRA_CLIENT_SECRET);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Get verification record" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Test company sign-in" })).toBeVisible();
    await expect(
      page.getByText(
        "The installation operator allows matching email addresses to link existing accounts.",
        { exact: true },
      ),
    ).toBeVisible();

    await page.getByRole("link", { name: "Email domains", exact: true }).click();
    await expect(page.getByText("No email domains", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add domain", exact: true }).click();
    await page.getByLabel("Domain", { exact: true }).fill("example.test");
    await page.getByRole("dialog").getByRole("button", { name: "Add domain", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Email domains" })).toContainText("example.test");
    await expect(page.getByRole("button", { name: "Verify", exact: true })).toHaveCount(0);

    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });

      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 960 });
        await page.screenshot({
          path: `../../.local/sso-domains-${theme}-${width}.png`,
          fullPage: true,
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
    }

    await page.getByRole("button", { name: "Remove example.test", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("No email domains", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Company sign-in", exact: true }).click();

    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });

      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 960 });
        await page.screenshot({ path: `../../.local/sso-${theme}-${width}.png`, fullPage: true });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
    }

    await page.setViewportSize({ width: 1280, height: 960 });
    await page.getByRole("button", { name: "Activate company SSO", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (
            await environment.database.db
              .select()
              .from(organizationSettings)
              .where(eq(organizationSettings.organizationId, "widefleet"))
          )[0]?.ssoRequired,
      )
      .toBe(true);
    const [stored] = await environment.database.db.select().from(ssoProvider);
    expect(stored).toMatchObject({ domain: "", domainVerified: false });
    await expect
      .poll(() => environment.authControl.read().configuration?.clientId)
      .toBe(environment.environment.ENTRA_CLIENT_ID);
    await page.goto("/sign-in");
    await expect(page.getByRole("button", { name: /Microsoft/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with email" })).toHaveCount(0);
  } finally {
    server.kill();

    if (server.exitCode === null) await once(server, "exit");
    await environment.close();
  }
});
