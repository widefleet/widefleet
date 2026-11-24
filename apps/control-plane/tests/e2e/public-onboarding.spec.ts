import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { user, member, organization, session } from "../../src/lib/server/auth-schema.ts";
import { createTestEnvironment } from "../environment.ts";

for (const entry of ["registration", "sign-in"] as const)
  test(`creates an organization and completes onboarding from ${entry}`, async ({ page }) => {
    test.setTimeout(120_000);
    const environment = await createTestEnvironment();
    const message = z.object({ to: z.email(), subject: z.string(), text: z.string() });
    const messages: z.infer<typeof message>[] = [];

    const mailbox = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));
        messages.push(message.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        response.writeHead(204).end();
      })().catch(() => response.writeHead(400).end());
    });

    mailbox.listen(0, "127.0.0.1");
    await once(mailbox, "listening");
    const port = z.object({ port: z.number() }).parse(mailbox.address()).port;

    const server = spawn(
      "pnpm",
      ["exec", "vite", "--host", "127.0.0.1", "--port", "25430", "--strictPort"],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: {
          ...process.env,
          ...environment.environment,
          WIDEFLEET_RUNTIME_EXTENSION: fileURLToPath(
            new URL("./public-onboarding-extension.ts", import.meta.url),
          ),
          PLATFORM_TEST_MAILBOX: `http://127.0.0.1:${port}`,
          WRANGLER_SEND_METRICS: "false",
        },
        detached: true,
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
          { timeout: 30_000 },
        )
        .toBe(true);
      await page.goto("/sign-in");

      if (entry === "registration") {
        await page.getByRole("link", { name: "Create an account" }).click();
        await page.getByLabel("Your name", { exact: true }).fill("Example Builder");
      }

      const codeLabel = entry === "registration" ? "Verification code" : "Sign-in code";

      const verifyLabel =
        entry === "registration" ? "Verify email and continue" : "Verify and sign in";

      await page.getByLabel("Email", { exact: true }).fill("new-builder@mail.test");
      await page
        .getByRole("button", {
          name: entry === "registration" ? "Continue" : "Continue with email",
          exact: true,
        })
        .click();
      await expect(page.getByLabel(codeLabel, { exact: true })).toBeVisible();
      expect(
        await environment.database.db
          .select()
          .from(user)
          .where(eq(user.email, "new-builder@mail.test")),
      ).toEqual([]);

      const otp = z
        .string()
        .parse(
          messages
            .findLast((entry) => entry.to === "new-builder@mail.test")
            ?.text.match(/code is (\d{6})/)?.[1],
        );

      await page
        .getByLabel(codeLabel, { exact: true })
        .fill(otp === "000000" ? "111111" : "000000");
      await page.getByRole("button", { name: verifyLabel }).click();
      await expect(
        page.getByText("Invalid or expired code. Request another code and try again.", {
          exact: true,
        }),
      ).toBeVisible();
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.evaluate((code) => navigator.clipboard.writeText(code), otp);
      const codeInput = page.getByLabel(codeLabel, { exact: true });
      await codeInput.focus();
      await codeInput.press("ControlOrMeta+a");
      await codeInput.press("ControlOrMeta+v");
      await expect(codeInput).toHaveValue(otp);
      await page.getByRole("button", { name: verifyLabel }).click();
      await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();

      expect(new URL(page.url()).searchParams.get("next")).toBe(
        entry === "registration" ? "/[organization]/apps" : "/[organization]",
      );
      await page.getByLabel("Name", { exact: true }).fill("Example Builders");
      await expect(page.getByLabel("URL", { exact: true })).toHaveValue("example-builders");
      environment.authControl.available(false);
      await page.getByRole("button", { name: "Create organization", exact: true }).click();
      await expect(
        page.getByText(
          "Your organization was created, but app sign-in is not ready. Retry or open organization settings.",
          {
            exact: true,
          },
        ),
      ).toBeVisible();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Example Builders");
      await expect(page.getByLabel("URL", { exact: true })).toHaveValue("example-builders");
      environment.authControl.available(true);
      await page.getByRole("button", { name: "Create organization", exact: true }).click();
      await expect(page).toHaveURL(/\/example-builders\/apps$/);

      const [created] = await environment.database.db
        .select()
        .from(organization)
        .where(eq(organization.slug, "example-builders"));

      if (!created) throw new Error("Organization was not created");
      expect(
        await environment.database.db
          .select()
          .from(member)
          .where(eq(member.organizationId, created.id)),
      ).toMatchObject([{ role: "owner" }]);
      await expect(page.getByRole("heading", { name: "Manage", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Build it with your agent" })).toBeVisible();

      const other = await page.request.get("/api/v1/apps", {
        headers: { "x-widefleet-organization": "widefleet" },
      });

      expect(other.status()).toBe(403);
      await page.goto("/organizations");
      await expect(page.getByRole("button", { name: "Create a new organization" })).toHaveCount(0);

      // A choice made after the session expires signs in again and returns to that organization.
      await environment.database.db.delete(session);
      await page.getByRole("link", { name: /Example Builders/ }).click();
      await expect(page).toHaveURL(/\/sign-in\?/);
      const destination = new URL(page.url()).searchParams.get("next");
      expect(destination).toBe("/example-builders");
      expect(page.url()).not.toContain("__data.json");
    } finally {
      await test
        .info()
        .attach("public-onboarding-server", { body: logs, contentType: "text/plain" });

      if (server.pid) process.kill(-server.pid, "SIGTERM");
      await new Promise<void>((resolve) => mailbox.close(() => resolve()));
      await environment.close();
    }
  });
