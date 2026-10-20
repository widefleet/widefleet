import { expect, test, type Browser } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { member, organization, session } from "../../src/lib/server/auth-schema.ts";
import { apps, fleets } from "../../src/lib/server/schema.ts";
import { createTestEnvironment } from "../environment.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let server: ReturnType<typeof spawn>;

let logs = "";

test.setTimeout(60_000);

test.beforeAll(async () => {
  environment = await createTestEnvironment();
  server = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../node_modules/vite/bin/vite.js", import.meta.url)),
      "--config",
      "tests/fixtures/organization-vite.ts",
      "--host",
      "127.0.0.1",
      "--port",
      "25430",
      "--strictPort",
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, ...environment.environment },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    logs += chunk;
  });
  server.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    logs += chunk;
  });
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
});

test.afterAll(async () => {
  if (server?.exitCode === null) {
    const exited = once(server, "exit");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
    server.kill("SIGTERM");
    await exited;
    clearTimeout(timeout);
  }

  await environment?.close();
});

test.afterEach(async ({ browserName }, info) => {
  if (info.status !== info.expectedStatus)
    await info.attach(`${browserName}-server-log`, { body: logs, contentType: "text/plain" });
});

const organizationSession = async (browser: Browser, javaScriptEnabled: boolean) => {
  const person = environment.users.createUser({
    name: "Organization Switcher",
    email: `switcher-${crypto.randomUUID()}@example.test`,
  });

  await environment.users.saveUser(person);
  const alpha = crypto.randomUUID();
  const beta = crypto.randomUUID();

  for (const [id, name] of [
    [alpha, "Alpha"],
    [beta, "Beta"],
  ] as const) {
    await environment.database.db
      .insert(organization)
      .values({ id, name, slug: id, createdAt: new Date() });
    await environment.database.db.insert(fleets).values({
      id: crypto.randomUUID(),
      name: id,
      organizationId: id,
      appDomain: `${id}.example.test`,
    });
    await environment.database.db.insert(member).values({
      id: crypto.randomUUID(),
      userId: person.id,
      organizationId: id,
      role: "admin",
      createdAt: new Date(),
    });
  }

  const login = await environment.users.login({ userId: person.id });

  const context = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
    javaScriptEnabled,
  });

  await context.addCookies(
    login.cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      sameSite: "Lax",
      secure: false,
    })),
  );

  return { person, alpha, beta, context };
};

for (const javaScriptEnabled of [true, false]) {
  test(`creates an app in the only organization without visiting the chooser (JavaScript ${javaScriptEnabled})`, async ({
    browser,
  }) => {
    const { person, alpha, beta, context } = await organizationSession(browser, javaScriptEnabled);
    await environment.database.db
      .delete(member)
      .where(and(eq(member.userId, person.id), eq(member.organizationId, beta)));

    try {
      const page = await context.newPage();
      await page.goto("/apps/new");
      await expect(page).toHaveURL(`${environment.configuration.PLATFORM_URL}/apps/new`);
      await expect(page.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
      await page.getByLabel("App name", { exact: true }).fill("Automatic organization");
      const slug = `automatic-${javaScriptEnabled}`;
      await page.getByLabel("URL slug").fill(slug);
      await page.getByRole("button", { name: "Create app", exact: true }).click();
      await expect(page).toHaveURL(/\/apps\/[a-f0-9-]+$/);

      const records = await environment.database.db
        .select({ organizationId: fleets.organizationId })
        .from(apps)
        .innerJoin(fleets, eq(apps.fleetId, fleets.id))
        .where(eq(apps.slug, slug));

      expect(records).toEqual([{ organizationId: alpha }]);
    } finally {
      await context.close();
    }
  });

  test(`rejects an old tab's app creation after another tab switches organizations (JavaScript ${javaScriptEnabled})`, async ({
    browser,
  }) => {
    const { alpha, beta, context } = await organizationSession(browser, javaScriptEnabled);

    try {
      const first = await context.newPage();
      const second = await context.newPage();
      await first.goto("/organizations");
      await first.getByRole("button", { name: /^Alpha admin$/i }).click();
      await expect(first).toHaveURL(`${environment.configuration.PLATFORM_URL}/`);
      await first.goto("/apps/new");
      await expect(first.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
      await expect(first.locator('input[name^="organizationId/"]')).toHaveValue(alpha);
      const slug = `stale-${javaScriptEnabled}`;
      await first.getByLabel("App name", { exact: true }).fill("Old tab app");
      await first.getByLabel("URL slug").fill(slug);

      await second.goto("/organizations");
      await second.getByRole("button", { name: /^Beta admin$/i }).click();
      await expect(second.getByRole("link", { name: "Choose organization: Beta" })).toBeVisible();
      await expect(first.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
      await first.getByRole("button", { name: "Create app", exact: true }).click();
      await expect(
        first.getByText(
          "Your organization selection changed. Reload this page before making changes.",
        ),
      ).toBeVisible();
      expect(await environment.database.db.select().from(apps).where(eq(apps.slug, slug))).toEqual(
        [],
      );

      await first.getByRole("link", { name: "Reload page", exact: true }).click();
      await expect(first.getByRole("link", { name: "Choose organization: Beta" })).toBeVisible();
      await first.getByLabel("App name", { exact: true }).fill("Reloaded tab app");
      await first.getByLabel("URL slug").fill(slug);
      await first.getByRole("button", { name: "Create app", exact: true }).click();
      await expect(first).toHaveURL(/\/apps\/[a-f0-9-]+$/);

      const records = await environment.database.db
        .select({ organizationId: fleets.organizationId })
        .from(apps)
        .innerJoin(fleets, eq(apps.fleetId, fleets.id))
        .where(eq(apps.slug, slug));

      expect(records).toEqual([{ organizationId: beta }]);
    } finally {
      await context.close();
    }
  });

  for (const activeOrganizationId of [null, "unavailable"]) {
    test(`returns to an app link after repairing selection ${activeOrganizationId} (JavaScript ${javaScriptEnabled})`, async ({
      browser,
    }) => {
      const { person, alpha, context } = await organizationSession(browser, javaScriptEnabled);

      try {
        await environment.database.db
          .update(session)
          .set({ activeOrganizationId })
          .where(eq(session.userId, person.id));

        const [fleet] = await environment.database.db
          .select()
          .from(fleets)
          .where(eq(fleets.organizationId, alpha));

        if (!fleet) throw new Error("Missing organization fixture fleet");
        const appId = crypto.randomUUID();
        await environment.database.db.insert(apps).values({
          id: appId,
          fleetId: fleet.id,
          ownerId: person.id,
          slug: "linked-app",
          displayName: "Linked app",
          hostname: `linked-app.${alpha}.example.test`,
        });
        const destination = `/apps/${appId}?q=linked%20app&view=overview`;
        const page = await context.newPage();
        await page.goto(destination);
        await expect(page).toHaveURL(/\/organizations(?:\?|$)/);
        await page.getByRole("button", { name: /^Alpha admin$/i }).click();
        await expect(page).toHaveURL(`${environment.configuration.PLATFORM_URL}${destination}`);
        await expect(page.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Linked app", exact: true })).toBeVisible();
      } finally {
        await context.close();
      }
    });
  }

  test(`rejects external destinations in the chooser and submitted form (JavaScript ${javaScriptEnabled})`, async ({
    browser,
  }) => {
    const { context } = await organizationSession(browser, javaScriptEnabled);

    try {
      const page = await context.newPage();
      await page.goto("/organizations?next=%2F%2Fexternal.example.test");
      const button = page.getByRole("button", { name: /^Alpha admin$/i });
      const form = page.locator("form").filter({ has: button });
      const next = form.locator('input[name^="next/"]');
      await expect(next).toHaveValue("/");
      await next.evaluate((input) => {
        if (!(input instanceof HTMLInputElement)) throw new Error("Missing next field");
        input.value = "//external.example.test";
      });
      await button.click();
      await expect(page).toHaveURL(`${environment.configuration.PLATFORM_URL}/`);
      await expect(page.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
    } finally {
      await context.close();
    }
  });
}
