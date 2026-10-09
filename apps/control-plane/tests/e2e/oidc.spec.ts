import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { account, member } from "../../src/lib/server/auth-schema.ts";
import { companyAccountProvider } from "../../src/lib/server/company-identity.ts";
import { createTestEnvironment } from "../environment.ts";

test("signs in through generic OIDC and enrolls the verified account as a management member", async ({
  page,
}) => {
  const environment = await createTestEnvironment("http://localhost:25431", "oidc");

  const server = spawn(process.execPath, ["build"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...process.env,
      ...environment.environment,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "25431",
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
    await page.goto(`${environment.configuration.PLATFORM_URL}/sign-in`);
    await page.getByRole("button", { name: "Sign in with Company SSO" }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(page.getByRole("heading", { name: "Your apps", exact: true })).toBeVisible();
    await expect(page.getByText("SSO Test User", { exact: true })).toBeVisible();

    const accounts = await environment.database.db
      .select()
      .from(account)
      .where(eq(account.providerId, companyAccountProvider(environment.configuration.IDENTITY)));

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerId: companyAccountProvider(environment.configuration.IDENTITY),
      accountId: expect.any(String),
    });
    expect(
      await environment.database.db.select().from(member).where(eq(member.role, "member")),
    ).toEqual([expect.objectContaining({ userId: accounts[0]?.userId, role: "member" })]);
    await page.getByRole("button", { name: /^Account:/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
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
