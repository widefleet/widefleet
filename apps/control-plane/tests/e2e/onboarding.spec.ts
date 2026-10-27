import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { organization, ssoProvider } from "../../src/lib/server/auth-schema.ts";
import {
  installation,
  organizationRuntimes,
  organizationSettings,
} from "../../src/lib/server/schema.ts";
import { prepareOrganizationInvitation } from "../../src/lib/server/members.ts";
import { createTestEnvironment } from "../environment.ts";
import { createIdentityProvider } from "../edge/auth-proxy-idp.ts";

const emailMessage = z.object({ to: z.email(), subject: z.string(), text: z.string() });

test("accepts emailed owner invitations and manages members in isolated organizations", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const environment = await createTestEnvironment();
  const messages: z.infer<typeof emailMessage>[] = [];
  const failedRecipients = new Set<string>();

  const mailbox = createServer((request, response) => {
    const receive = async () => {
      const chunks: Buffer[] = [];

      for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));
      const message = emailMessage.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));

      if (failedRecipients.has(message.to)) {
        response.writeHead(503).end();

        return;
      }

      messages.push(message);
      response.writeHead(204).end();
    };

    void receive().catch(() => response.writeHead(400).end());
  });

  mailbox.listen(0, "127.0.0.1");
  await once(mailbox, "listening");
  const mailboxPort = z.object({ port: z.number() }).parse(mailbox.address()).port;
  await environment.database.db
    .update(organizationSettings)
    .set({
      settings: {
        directory: null,
        externallyManaged: false,
      },
    })
    .where(eq(organizationSettings.organizationId, "widefleet"));

  await environment.database.db
    .update(installation)
    .set({ ownerId: null })
    .where(eq(installation.id, "widefleet"));
  await environment.database.db
    .delete(ssoProvider)
    .where(eq(ssoProvider.organizationId, "widefleet"));
  environment.authControl.available(false);

  const createCompany = async (slug: string, email = `${slug}@mail.test`) => {
    const organizationId = crypto.randomUUID();
    await environment.database.db
      .insert(organization)
      .values({ id: organizationId, name: slug, slug, createdAt: new Date() });
    await environment.database.db
      .insert(organizationRuntimes)
      .values({ organizationId, appHostnameSuffix: slug });

    const prepared = await environment.database.db.transaction((transaction) =>
      prepareOrganizationInvitation(transaction, organizationId, environment.owner.id, {
        email,
        role: "owner",
      }),
    );

    return { organizationId, email, invitationId: prepared.invitation.id };
  };

  const first = await createCompany("browser-alpha");
  const second = await createCompany("browser-bravo");
  const company = await createCompany("browser-company", "user@example.test");

  const provider = await createIdentityProvider(
    `${environment.configuration.PLATFORM_URL}/api/auth/sso/callback/invitation-company`,
    false,
  );

  const server = spawn(
    "pnpm",
    ["exec", "vite", "--host", "127.0.0.1", "--port", "25430", "--strictPort"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        ...environment.environment,
        WIDEFLEET_RUNTIME_EXTENSION: fileURLToPath(
          new URL("./onboarding-extension.ts", import.meta.url),
        ),
        PLATFORM_TEST_MAILBOX: `http://127.0.0.1:${mailboxPort}`,
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

  const operatorContext = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
  });

  operatorContext.setDefaultTimeout(10_000);

  const firstContext = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
  });

  const secondContext = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
  });

  const companyContext = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
  });

  const emailContext = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
  });

  const signIn = async (page: Page, email: string, checkEmailState = false) => {
    const form = page.locator("form").filter({ has: page.locator("#code-email") });
    await form.getByLabel("Email", { exact: true }).fill(email);

    if (checkEmailState) {
      const pending = new EventEmitter();
      const requested = once(pending, "requested");
      const released = once(pending, "released");
      await page.route(
        "**/api/auth/email-otp/send-verification-otp",
        async (route) => {
          pending.emit("requested");
          await released;
          await route.fulfill({ status: 503, json: { message: "Temporarily unavailable" } });
        },
        { times: 1 },
      );
      await form.getByRole("button", { name: "Continue", exact: true }).click();
      await requested;

      try {
        await expect(page.locator("#code-email")).toBeDisabled();
        await expect(page.locator("input[type=password]")).toHaveCount(0);
      } finally {
        pending.emit("released");
      }

      await expect(
        page.getByText("Could not send a sign-in code. Please try again."),
      ).toBeVisible();
      await expect(page.locator("#code-email")).toBeEnabled();
      await expect(page.locator("#code-email")).toHaveValue(email);
      await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveCount(0);
    }

    await form.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByLabel("Sign-in code", { exact: true })).toBeVisible();

    if (checkEmailState) {
      await expect(page.locator("input[type=password]")).toHaveCount(0);
      await expect(page.locator("#code-email")).toHaveValue(email);
      await expect(page.locator("#code-email")).toHaveAttribute("readonly", "");
    }

    const code = z
      .string()
      .parse(
        messages
          .findLast((message) => message.to === email && message.subject.includes("sign-in code"))
          ?.text.match(/code is (\d{6})/)?.[1],
      );

    await page.getByLabel("Sign-in code", { exact: true }).fill(code);
    await form.getByRole("button", { name: "Sign in", exact: true }).click();
  };

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

    const operator = await operatorContext.newPage();
    await operator.goto("/setup");
    await operator.waitForLoadState("networkidle");
    await operator.getByLabel("Name", { exact: true }).fill("Email Setup Owner");
    await operator.getByLabel("Organization name", { exact: true }).fill("Example Team");
    await operator.getByLabel("Email", { exact: true }).fill("email-setup@example.test");
    await operator.getByRole("button", { name: "Create account and continue" }).click();
    await expect(operator).toHaveURL(/\/sign-in\?/);
    await signIn(operator, "email-setup@example.test");
    await expect(operator).toHaveURL(/\/welcome$/);
    await expect(operator.getByRole("heading", { name: "Publish your first app" })).toBeVisible();
    await operator.getByRole("link", { name: "Organization settings", exact: true }).click();
    await expect(
      operator.getByRole("status").filter({ hasText: "The auth proxy is unavailable" }),
    ).toBeVisible();
    environment.authControl.available(true);
    await operator.getByRole("button", { name: "Activate Widefleet sign-in" }).click();
    await expect(
      operator.getByRole("status").filter({ hasText: "Widefleet app sign-in is active." }),
    ).toBeVisible();

    // Configure company SSO, remove it, then configure it again without reloading.
    // The removed provider must not leave saved credentials in the browser draft.
    const configure = async () => {
      await operator.getByRole("button", { name: "Configure company SSO", exact: true }).click();
      await operator.getByLabel("Company email domain").fill("example.test");
      await operator
        .getByLabel("Issuer URL")
        .fill(
          `${environment.environment.ENTRA_AUTHORITY}/${environment.environment.ENTRA_TENANT_ID}/v2.0`,
        );
      await expect(operator.getByLabel("Client secret", { exact: true })).toHaveValue("");
      await operator
        .getByLabel("Client ID", { exact: true })
        .fill(environment.environment.ENTRA_CLIENT_ID);
      await operator
        .getByLabel("Client secret", { exact: true })
        .fill(environment.environment.ENTRA_CLIENT_SECRET);
      await operator.getByLabel("App identity claims").selectOption("entra");
      await operator.getByRole("button", { name: "Save", exact: true }).click();
      await expect(
        operator.getByText("Leave blank to keep the saved secret.", { exact: true }),
      ).toBeVisible();
    };

    await configure();
    await operator.getByRole("button", { name: "Get verification record" }).click();
    await expect(
      operator.getByText("_better-auth-token-company-widefleet.example.test", { exact: true }),
    ).toBeVisible();
    await operator.getByLabel("Company email domain").fill("changed.example.test");
    await operator.getByRole("button", { name: "Save", exact: true }).click();
    await expect(operator.getByText("Settings saved.", { exact: true })).toBeVisible();
    await expect(operator.getByRole("button", { name: "Get verification record" })).toBeVisible();
    await expect(
      operator.getByText("_better-auth-token-company-widefleet.example.test", { exact: true }),
    ).toHaveCount(0);
    await operator.getByRole("button", { name: "Get verification record" }).click();
    await expect(
      operator.getByText("_better-auth-token-company-widefleet.changed.example.test", {
        exact: true,
      }),
    ).toBeVisible();
    await operator
      .getByRole("button", { name: "Remove company SSO and use Widefleet", exact: true })
      .click();
    await expect(
      operator.getByRole("button", { name: "Configure company SSO", exact: true }),
    ).toBeVisible();
    await configure();
    await expect(operator.getByRole("button", { name: "Get verification record" })).toBeVisible();
    await expect(
      operator.getByText("_better-auth-token-company-widefleet.changed.example.test", {
        exact: true,
      }),
    ).toHaveCount(0);

    // A recipient may already have an email session when their company enables SSO.
    const emailPage = await emailContext.newPage();
    await emailPage.goto(`/invitations/${company.invitationId}`);
    await signIn(emailPage, company.email, true);
    await expect(emailPage.getByRole("heading", { name: "Join browser-company" })).toBeVisible();
    const { adapter } = await environment.auth.$context;
    await adapter.create({
      model: "ssoProvider",
      data: {
        providerId: "invitation-company",
        organizationId: company.organizationId,
        issuer: provider.origin,
        domain: "example.test",
        domainVerified: true,
        oidcConfig: JSON.stringify({
          clientId: "app-login",
          clientSecret: "synthetic-client-secret",
          issuer: provider.origin,
          discoveryEndpoint: `${provider.origin}/.well-known/openid-configuration`,
          pkce: true,
          scopes: ["openid", "profile", "email"],
          mapping: { email: "mail", name: "display_name" },
        }),
      },
    });

    await environment.database.db
      .insert(organizationSettings)
      .values({
        organizationId: company.organizationId,
        settings: {},
        ssoRequired: true,
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: { ssoRequired: true },
      });

    const emailAcceptance = await emailContext.request.post(
      `/api/v1/invitations/${company.invitationId}/accept`,
      {
        headers: { origin: environment.configuration.PLATFORM_URL },
        data: {},
      },
    );

    expect(emailAcceptance.status()).toBe(403);
    // Submission of a page rendered before SSO was enabled must also restart company sign-in.
    await expect(emailPage.getByLabel("Your name")).toHaveCount(0);
    await emailPage.getByRole("button", { name: "Accept invitation" }).click();
    const companyPage = await companyContext.newPage();
    await companyPage.goto(`/invitations/${company.invitationId}`);
    await companyPage.waitForLoadState("networkidle");

    for (const page of [emailPage, companyPage]) {
      await expect(page).toHaveURL(/\/sign-in\?organization=browser-company&next=/);
      expect(new URL(page.url()).searchParams.get("next")).toBe(
        `/invitations/${company.invitationId}`,
      );
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Sign in with browser-company" }).click();
      await expect(page.getByRole("heading", { name: "Join browser-company" })).toBeVisible();
      await expect(page.getByLabel("Your name")).toHaveCount(0);
    }

    await companyPage.getByRole("button", { name: "Accept invitation" }).click();
    await expect(companyPage).toHaveURL(`${environment.configuration.PLATFORM_URL}/`);
    const accepted = await companyContext.request.get("/api/v1/me");
    expect(accepted.status(), await accepted.text()).toBe(200);
    expect(await accepted.json()).toMatchObject({
      application: { organizationId: company.organizationId, admin: true },
      role: "owner",
    });

    for (const [company, context] of [
      [first, firstContext],
      [second, secondContext],
    ] as const) {
      const page = await context.newPage();
      await page.goto(`/invitations/${company.invitationId}`);
      await expect(page).toHaveURL(/\/sign-in\?/);
      await signIn(page, company.email);
      await expect(
        page.getByRole("heading", { name: `Join ${company.email.split("@")[0]}` }),
      ).toBeVisible();
      await expect(page.getByLabel("Your name")).toHaveCount(0);
      await page.getByRole("button", { name: "Accept invitation" }).click();
      await expect(page).toHaveURL(`${environment.configuration.PLATFORM_URL}/`);

      const created = await context.request.post("/api/v1/apps", {
        headers: { origin: environment.configuration.PLATFORM_URL },
        data: { slug: "notes", displayName: "Notes" },
      });

      expect(created.status(), await created.text()).toBe(200);
      const app = z.object({ hostname: z.string() }).parse(await created.json());
      expect(app.hostname).toBe(
        `notes-${company.email.split("@")[0]}.${environment.configuration.APP_DOMAIN}`,
      );
      await page.goto("/members");
      await page.getByText("Invite a member", { exact: true }).click();
      await page.getByLabel("Email", { exact: true }).fill(`member-${company.email}`);
      failedRecipients.add(`member-${company.email}`);
      await page.getByRole("button", { name: "Send invitation" }).click();
      await expect(
        page.getByText("Invitation saved. If the email hasn't arrived, use Resend invitation."),
      ).toBeVisible();

      const pending = page
        .getByRole("region", { name: "Pending invitations" })
        .getByRole("listitem");

      await expect(pending).toHaveCount(1);
      await expect(pending).toContainText(`member-${company.email}`);
      expect(messages.some((message) => message.to === `member-${company.email}`)).toBe(false);
      failedRecipients.delete(`member-${company.email}`);
      await pending.getByRole("button", { name: "Resend invitation" }).click();
      await expect(
        page.getByText("Invitation saved. If the email hasn't arrived, use Resend invitation.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(pending).toHaveCount(1);
      await expect
        .poll(
          () =>
            messages.filter(
              (message) =>
                message.to === `member-${company.email}` && message.text.includes("/invitations/"),
            ).length,
        )
        .toBe(1);
      await page.goto("/settings");
      await expect(
        page.getByText("Apps use Widefleet sign-in until company SSO is activated.", {
          exact: false,
        }),
      ).toBeVisible();
    }

    const denied = await firstContext.request.get(`/api/v1/apps`, {
      headers: { "x-widefleet-organization": second.organizationId },
    });

    expect(denied.status()).toBe(403);

    // DNS proof alone leaves email access and built-in app sign-in available.
    await environment.database.db
      .update(ssoProvider)
      .set({ domainVerified: true })
      .where(eq(ssoProvider.organizationId, "widefleet"));
    await operator.goto("/settings");
    await operator.waitForLoadState("networkidle");
    await expect(operator.getByRole("button", { name: "Test company sign-in" })).toBeVisible();
    await expect(
      operator.getByRole("button", { name: "Activate company SSO", exact: true }),
    ).toBeEnabled();
    expect((await operatorContext.request.get("/api/v1/me")).status()).toBe(200);
    const loginPage = await firstContext.newPage();
    await loginPage.goto("/sign-in?organization=widefleet&next=%2Fsettings");
    await expect(loginPage.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
    await signIn(loginPage, "email-setup@example.test");
    await expect(loginPage).toHaveURL(/\/settings$/);
    // Both operator sessions were verified by OTP. Activating SSO must deny
    // organization access to each of them without deleting the global account.
    await loginPage.waitForLoadState("networkidle");
    await loginPage.getByRole("button", { name: "Activate company SSO", exact: true }).click();
    await expect(loginPage).not.toHaveURL(/\/settings$/);
    expect((await firstContext.request.get("/api/v1/me")).status()).toBe(403);
    expect((await operatorContext.request.get("/api/v1/me")).status()).toBe(403);

    const [policy] = await environment.database.db
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, "widefleet"));

    expect(policy?.ssoRequired).toBe(true);
    await loginPage.goto("/sign-in?organization=widefleet");
    await expect(loginPage.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  } catch (cause) {
    await test.info().attach("onboarding-server-log", { body: logs, contentType: "text/plain" });

    for (const context of [
      operatorContext,
      firstContext,
      secondContext,
      companyContext,
      emailContext,
    ]) {
      for (const page of context.pages())
        await test.info().attach("onboarding-page", {
          body: await page
            .locator("body")
            .innerText({ timeout: 1000 })
            .catch(() => page.url()),
          contentType: "text/plain",
        });
    }

    throw cause;
  } finally {
    await Promise.allSettled([
      operatorContext.close(),
      firstContext.close(),
      secondContext.close(),
      companyContext.close(),
      emailContext.close(),
    ]);

    if (server.exitCode === null && server.pid) {
      const exited = once(server, "exit");
      const pid = server.pid;

      const timeout = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }, 5000);

      process.kill(-pid, "SIGTERM");
      await exited;
      clearTimeout(timeout);
    }

    await new Promise<void>((resolve, reject) =>
      mailbox.close((error) => (error ? reject(error) : resolve())),
    );
    await provider.stop();
    await environment.close();
  }
});
