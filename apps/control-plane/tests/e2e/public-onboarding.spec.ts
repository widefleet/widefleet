import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { user, member, organization } from "../../src/lib/server/auth-schema.ts";
import { createTestEnvironment } from "../environment.ts";

test("registers a verified account, creates its organization and guides the first deployment", async ({
  page,
}) => {
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
    await page.getByRole("link", { name: "Create an account" }).click();
    await page.getByLabel("Your name", { exact: true }).fill("Example Builder");
    await page.getByLabel("Email", { exact: true }).fill("new-builder@mail.test");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByLabel("Verification code", { exact: true })).toBeVisible();
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
      .getByLabel("Verification code", { exact: true })
      .fill(otp === "000000" ? "111111" : "000000");
    await page.getByRole("button", { name: "Verify email and continue" }).click();
    await expect(
      page.getByText("Invalid or expired code. Request another code and try again.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate((code) => navigator.clipboard.writeText(code), otp);
    const codeInput = page.getByLabel("Verification code", { exact: true });
    await codeInput.focus();
    await codeInput.press("ControlOrMeta+a");
    await codeInput.press("ControlOrMeta+v");
    await expect(codeInput).toHaveValue(otp);
    await page.getByRole("button", { name: "Verify email and continue" }).click();
    await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
    await page.getByLabel("Organization name", { exact: true }).fill("Example Builders");
    await page.getByLabel("Organization URL name", { exact: true }).fill("example-builders");
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
    environment.authControl.available(true);
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole("heading", { name: "Publish your first app" })).toBeVisible();

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
    await expect(page.locator("pre").filter({ hasText: "widefleet deploy" })).toContainText(
      `--organization ${created.id}`,
    );
    await page.getByRole("link", { name: "Open apps", exact: true }).click();
    await expect(page.getByText("Room for your first idea", { exact: true })).toBeVisible();

    const other = await page.request.get("/api/v1/apps", {
      headers: { "x-widefleet-organization": "widefleet" },
    });

    expect(other.status()).toBe(403);
    await page.goto("/organizations");
    await expect(page.getByRole("button", { name: "Set up your own organization" })).toHaveCount(0);
  } finally {
    await test.info().attach("public-onboarding-server", { body: logs, contentType: "text/plain" });

    if (server.pid) process.kill(-server.pid, "SIGTERM");
    await new Promise<void>((resolve) => mailbox.close(() => resolve()));
    await environment.close();
  }
});
