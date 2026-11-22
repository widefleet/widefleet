import { expect, test, type Browser, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { UnsecuredJWT } from "jose";
import { z } from "zod";
import { account, member, organization } from "../../src/lib/server/auth-schema.ts";
import { organizationRuntimes, organizationSettings } from "../../src/lib/server/schema.ts";
import { createTestEnvironment } from "../environment.ts";

test("joins an organization by email domain and manages its join domains", async ({ browser }) => {
  test.setTimeout(180_000);
  const environment = await createTestEnvironment();
  const database = environment.database.db;
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

  // A Google Workspace sign-in saves an ID token whose hosted domain proves the address.
  const person = async (email: string, name: string, workspace: boolean) => {
    const created = environment.users.createUser({ email, name, emailVerified: true });
    await environment.users.saveUser(created);

    if (workspace)
      await database.insert(account).values({
        id: crypto.randomUUID(),
        providerId: "widefleet-google",
        accountId: crypto.randomUUID(),
        userId: created.id,
        idToken: new UnsecuredJWT({
          email,
          email_verified: true,
          hd: email.split("@")[1],
        }).encode(),
      });

    return created.id;
  };

  const signIn = async (current: Browser, email: string) => {
    const page: Page = await (await current.newContext()).newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Continue with email", exact: true }).click();
    await expect(page.getByLabel("Sign-in code", { exact: true })).toBeVisible();

    const code = () =>
      messages.findLast((entry) => entry.to === email)?.text.match(/code is (\d{6})/)?.[1];

    await expect.poll(code).toMatch(/^\d{6}$/);

    await page.getByLabel("Sign-in code", { exact: true }).fill(z.string().parse(code()));
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    return page;
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

    const owner = await person("owner@team.example.test", "Grace Owner", true);
    const colleague = await person("ada@team.example.test", "Ada Colleague", false);
    const team = crypto.randomUUID();
    await database
      .insert(organization)
      .values({ id: team, name: "Example Team", slug: "example-team", createdAt: new Date() });
    await database.insert(member).values([
      {
        id: crypto.randomUUID(),
        organizationId: team,
        userId: owner,
        role: "owner",
        createdAt: new Date(Date.now() - 60_000),
      },
      {
        id: crypto.randomUUID(),
        organizationId: team,
        userId: colleague,
        role: "member",
        createdAt: new Date(),
      },
    ]);
    await database
      .insert(organizationRuntimes)
      .values({ organizationId: team, appHostnameSuffix: "example-team" });
    await database.insert(organizationSettings).values({
      organizationId: team,
      settings: {},
      joinDomains: ["team.example.test"],
    });

    // A new colleague signs in by email code and joins without an invitation.
    const newcomer = await signIn(browser, "new@team.example.test");
    await expect(newcomer.getByRole("heading", { name: "Join your team" })).toBeVisible();
    await expect(
      newcomer.getByText("2 members, including Grace Owner and Ada Colleague", { exact: true }),
    ).toBeVisible();
    await newcomer.getByRole("button", { name: "Join", exact: true }).click();
    await expect(newcomer).toHaveURL(/\/example-team(\/|$)/);
    expect(
      await database
        .select({ role: member.role })
        .from(member)
        .where(eq(member.organizationId, team)),
    ).toHaveLength(3);

    // An administrator removes and restores the join domain their Google sign-in proves.
    const administrator = await signIn(browser, "owner@team.example.test");
    await expect(administrator).toHaveURL(/\/example-team(\/|$)/);
    await administrator.goto("/example-team/settings/members");
    await administrator.waitForLoadState("networkidle");
    const domains = administrator.getByRole("list", { name: "Join domains" });
    await expect(domains.getByText("team.example.test", { exact: true })).toBeVisible();
    await administrator
      .getByRole("button", { name: "Stop letting team.example.test addresses join" })
      .click();
    await expect(domains).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await database
              .select({ joinDomains: organizationSettings.joinDomains })
              .from(organizationSettings)
              .where(eq(organizationSettings.organizationId, team))
          )[0]?.joinDomains,
      )
      .toEqual([]);
    await administrator
      .getByRole("button", { name: "Let anyone with a @team.example.test address join" })
      .click();
    await expect(domains.getByText("team.example.test", { exact: true })).toBeVisible();

    // A creator with a Google Workspace sign-in opens a new organization to their domain.
    await person("builder@builders.example.test", "Builder", true);
    const builder = await signIn(browser, "builder@builders.example.test");
    await expect(builder.getByRole("heading", { name: "Create your organization" })).toBeVisible();

    const toggle = builder.getByRole("switch", {
      name: "Allow anyone with a @builders.example.test address to join",
    });

    await expect(toggle).toBeChecked();
    await builder.getByLabel("Organization name", { exact: true }).fill("Builders");
    await builder.getByLabel("Organization URL name", { exact: true }).fill("builders");
    await builder.getByRole("button", { name: "Create organization", exact: true }).click();
    await expect(builder).toHaveURL(/\/builders\/welcome$/);

    const [created] = await database
      .select({ joinDomains: organizationSettings.joinDomains })
      .from(organizationSettings)
      .innerJoin(organization, eq(organization.id, organizationSettings.organizationId))
      .where(eq(organization.slug, "builders"));

    expect(created?.joinDomains).toEqual(["builders.example.test"]);
  } finally {
    await test.info().attach("domain-join-server", { body: logs, contentType: "text/plain" });

    if (server.pid) process.kill(-server.pid, "SIGTERM");
    await new Promise<void>((resolve) => mailbox.close(() => resolve()));
    await environment.close();
  }
});
