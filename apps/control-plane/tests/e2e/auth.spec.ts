import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { app, artifact } from "@platform/contracts";
import { member } from "../../src/lib/server/auth-schema.ts";
import {
  agents,
  appRoleAssignments,
  apps,
  artifacts,
  deployments,
} from "../../src/lib/server/schema.ts";
import { apiResource, cliClientId } from "../../src/lib/server/auth-options.ts";
import { createTestEnvironment } from "../environment.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let server: ReturnType<typeof spawn>;

let logs = "";

test.beforeAll(async () => {
  environment = await createTestEnvironment();
  server = spawn(process.execPath, ["build"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...process.env,
      ...environment.environment,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "25430",
      PROTOCOL_HEADER: "x-forwarded-proto",
      SHUTDOWN_TIMEOUT: "1",
      BODY_SIZE_LIMIT: "32M",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      { timeout: 15_000 },
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

test("preserves SvelteKit form protection and accepts the CLI with an explicit Origin", async ({
  request,
}) => {
  const fields = {
    client_id: cliClientId,
    scope: "openid platform:read",
    resource: apiResource(environment.configuration),
  };

  const direct = await environment.auth.handler(
    new Request(`${environment.configuration.PLATFORM_URL}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
  );

  const withoutOrigin = await request.post("/api/auth/device/code", { form: fields });

  const withOrigin = await request.post("/api/auth/device/code", {
    form: fields,
    headers: { origin: environment.configuration.PLATFORM_URL },
  });

  const json = await request.post("/api/auth/device/code", { data: fields });
  expect(direct.status).toBe(200);
  expect(withoutOrigin.status()).toBe(403);
  expect(await withoutOrigin.text()).toBe("Cross-site POST form submissions are forbidden");
  expect(withOrigin.status()).toBe(200);
  expect(json.status()).toBe(200);

  const foreignOrigin = await request.post("/api/auth/device/code", {
    form: fields,
    headers: { origin: "https://other.example.test" },
  });

  expect(foreignOrigin.status()).toBe(403);
});

test("redirects anonymous device requests to login and preserves the code", async ({ page }) => {
  await page.goto("/device?user_code=ABCD1234");
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await expect(page.getByRole("button", { name: "Sign in with Microsoft" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("next")).toBe("/device?user_code=ABCD1234");
});

test("starts Entra login with a host-only HttpOnly state cookie", async ({ request }) => {
  const response = await request.post("/api/auth/sign-in/social", {
    headers: { origin: environment.configuration.PLATFORM_URL },
    data: {
      provider: "microsoft",
      callbackURL: "/device?user_code=ABCD1234",
      disableRedirect: true,
    },
  });

  expect(response.status()).toBe(200);
  const result = z.object({ url: z.url() }).parse(await response.json());
  const target = new URL(result.url);
  expect(target.origin).toBe(environment.environment.ENTRA_AUTHORITY);
  expect(target.pathname).toBe("/oauth2/v2.0/authorize");
  expect(target.searchParams.get("redirect_uri")).toBe(
    `${environment.configuration.PLATFORM_URL}/api/auth/callback/microsoft`,
  );

  const cookies = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie");

  expect(cookies.length).toBeGreaterThan(0);

  for (const cookie of cookies) {
    expect(cookie.value.toLowerCase()).toContain("httponly");
    expect(cookie.value.toLowerCase()).not.toContain("domain=");
  }
});

test("completes Microsoft login against emulate through the built SvelteKit server", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
  await page.getByRole("button", { name: /sso@example.test/ }).click();
  await expect(page.getByRole("heading", { name: "Your apps", exact: true })).toBeVisible();
  await expect(page.getByText("SSO Test User", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("requires code confirmation in the browser, grants the CLI, then signs out", async ({
  page,
  context,
  request,
}) => {
  const person = environment.users.createUser({
    name: "Example User",
    email: "browser@example.test",
  });

  await environment.users.saveUser(person);
  await environment.linkMicrosoftUser(person.id, crypto.randomUUID());
  const session = await environment.users.login({ userId: person.id });
  await context.addCookies(
    session.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: "localhost",
      path: cookie.path,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    })),
  );

  const response = await request.post("/api/auth/device/code", {
    headers: { origin: environment.configuration.PLATFORM_URL },
    form: {
      client_id: cliClientId,
      scope: "openid offline_access platform:read",
      resource: apiResource(environment.configuration),
    },
  });

  expect(response.status()).toBe(200);

  const device = z
    .object({ device_code: z.string(), user_code: z.string() })
    .parse(await response.json());

  await page.goto(`/device?user_code=${device.user_code}`);
  await expect(page.getByLabel("Device code")).toHaveValue(device.user_code);
  await page.getByRole("button", { name: "Check code" }).click();
  const approve = page.getByRole("button", { name: "Authorize CLI" });
  await expect(approve).toBeDisabled();
  await expect(
    page.getByText(apiResource(environment.configuration), { exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox").check();
  await approve.click();
  await expect(page.getByRole("status")).toContainText("CLI connected");

  const token = await request.post("/api/auth/oauth2/token", {
    headers: { origin: environment.configuration.PLATFORM_URL },
    form: {
      client_id: cliClientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  });

  expect(token.status()).toBe(200);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your apps", exact: true })).toBeVisible();
  await expect(page.getByText("Example User", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/device");
  await expect(page).toHaveURL(/\/sign-in\?next=/);
});

test("registers an agent, creates an app and an isolated preview, then requests deletion", async ({
  page,
  context,
}) => {
  const person = environment.users.createUser({
    name: "Platform Admin",
    email: "ui-admin@example.test",
  });

  await environment.users.saveUser(person);
  await environment.linkMicrosoftUser(person.id, z.uuid().parse(environment.ownerSubject));
  const session = await environment.users.login({ userId: person.id });
  await context.addCookies(
    session.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: "localhost",
      path: cookie.path,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    })),
  );

  await page.goto("/agents");
  await page.getByText("Register deployment agent", { exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Local deployment host");
  await page.getByRole("button", { name: "Register agent" }).click();
  await expect(page.getByRole("status")).toContainText("agent_");
  await page.goto("/agents");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("link", { name: "All apps", exact: true }).click();
  await page.getByRole("link", { name: "Create app", exact: true }).click();
  await page.getByLabel("App name", { exact: true }).fill("Team Notes");
  await expect(page.getByLabel("Deployment-Agent", { exact: true })).toHaveCount(0);
  await page.getByLabel("URL slug").fill("team-notes");
  await page.getByRole("button", { name: "Create app" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Team Notes");
  await expect(page.getByText("No deployments yet.", { exact: false })).toBeVisible();
  const appId = z.uuid().parse(new URL(page.url()).pathname.split("/").at(-1));

  await page.getByRole("link", { name: "Create preview", exact: true }).click();
  await page.getByLabel("App name", { exact: true }).fill("Notes Preview");
  await page.getByLabel("URL slug").fill("notes-preview");
  await page.getByLabel("Preview of an existing app").selectOption(appId);
  await page.getByRole("button", { name: "Create app" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Notes Preview");
  await expect(page.getByRole("link", { name: "Back to original app" })).toHaveAttribute(
    "href",
    `/apps/${appId}`,
  );
  await expect(page.getByText("notes-preview.apps.localhost", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "App settings", exact: true }).click();
  await page.getByText("Permanently delete app", { exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Delete app", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your apps" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Notes Preview" })).toContainText(
    "Deleting",
  );
  await expect(page.getByRole("listitem").filter({ hasText: "Team Notes" })).toContainText(
    "Not published yet",
  );
});

test("manages organization roles and app access by name while members create their own apps", async ({
  page,
  context,
  browser,
}) => {
  const [owner] = await environment.database.db
    .select()
    .from(member)
    .where(eq(member.role, "owner"));

  if (!owner) throw new Error("Expected initial owner");

  const ownerSession = await environment.users.login({ userId: owner.userId });
  await context.addCookies(
    ownerSession.cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      sameSite: "Lax",
      secure: false,
    })),
  );

  const person = environment.users.createUser({
    name: "Member Example",
    email: "member-ui@example.test",
  });

  await environment.users.saveUser(person);
  await environment.linkMicrosoftUser(person.id);
  const memberSession = await environment.users.login({ userId: person.id });

  const memberContext = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
    extraHTTPHeaders: { "x-forwarded-proto": "http" },
  });

  try {
    await memberContext.addCookies(
      memberSession.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        sameSite: "Lax",
        secure: false,
      })),
    );
    const memberPage = await memberContext.newPage();
    await memberPage.goto("/");
    await expect(memberPage.getByRole("link", { name: "Members", exact: true })).toHaveCount(0);
    expect((await memberContext.request.get("/members")).status()).toBe(403);
    await memberPage.getByRole("link", { name: "Create app", exact: true }).click();
    await memberPage.getByLabel("App name", { exact: true }).fill("Member Workspace");
    await memberPage.getByLabel("URL slug").fill("member-workspace");
    await memberPage.getByRole("button", { name: "Create app" }).click();
    await expect(memberPage.getByRole("heading", { level: 1 })).toHaveText("Member Workspace");

    await page.goto("/");
    await page.getByRole("link", { name: "Members", exact: true }).click();
    await page.getByLabel("Search by name or email").fill("member-ui@");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const roleForm = page.getByRole("form", { name: "Role for Member Example" });
    await roleForm.getByLabel("Role", { exact: true }).selectOption("admin");
    await roleForm.getByRole("button", { name: "Save role" }).click();
    await expect(page.getByRole("status")).toContainText("Role saved");
    await memberPage
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "All apps", exact: true })
      .click();
    await expect(memberPage.getByRole("link", { name: "Members", exact: true })).toBeVisible();
    await expect(
      memberPage
        .getByRole("button", { name: /^Account:/ })
        .getByText("Administrator", { exact: true }),
    ).toBeVisible();

    await page
      .getByRole("form", { name: "Role for Member Example" })
      .getByLabel("Role", { exact: true })
      .selectOption("member");
    await page
      .getByRole("form", { name: "Role for Member Example" })
      .getByRole("button", { name: "Save role" })
      .click();
    await expect(page.getByRole("status")).toContainText("Role saved");
    expect((await memberContext.request.get("/members")).status()).toBe(403);

    await memberPage.getByRole("link", { name: "Create app", exact: true }).click();
    await expect(memberPage.getByRole("link", { name: "Members", exact: true })).toHaveCount(0);
    await expect(
      memberPage.getByRole("button", { name: /^Account:/ }).getByText("Member", { exact: true }),
    ).toBeVisible();

    await page.goto("/");
    await page.getByRole("link", { name: "Team Notes", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Team Notes");
    const appPath = new URL(page.url()).pathname;
    expect((await memberContext.request.get(appPath)).status()).toBe(404);
    await page.getByRole("link", { name: "Access", exact: true }).click();
    await page.getByRole("link", { name: "Management access", exact: true }).click();
    await page.getByLabel("Find a member by name or email").fill("member-ui@");
    await page.getByRole("button", { name: "Find member" }).click();
    await page.getByRole("button", { name: "Grant access" }).click();
    await expect(page.locator("#access").getByRole("status")).toHaveText("App access saved.");
    await memberPage.goto(appPath);
    await expect(memberPage.getByRole("heading", { level: 1 })).toHaveText("Team Notes");
    await expect(memberPage.getByRole("button", { name: "Grant access" })).toHaveCount(0);
    await page.getByRole("button", { name: "Revoke access" }).click();
    await expect(page.locator("#access").getByRole("status")).toHaveText("App access saved.");
    expect((await memberContext.request.get(appPath)).status()).toBe(404);
  } finally {
    await memberContext.close();
  }
});

test("refreshes queued rollbacks and distinguishes pending requests from accepted jobs", async ({
  page,
  context,
}) => {
  const session = await environment.users.login({ userId: environment.owner.id });

  await context.addCookies(
    session.cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      sameSite: "Lax",
      secure: false,
    })),
  );

  const created = await context.request.post("/api/v1/apps", {
    headers: { origin: environment.configuration.PLATFORM_URL },
    data: { slug: "rollback-ui", displayName: "Rollback Example" },
  });

  expect(created.ok()).toBe(true);
  const record = app.parse(await created.json());
  const versions = [crypto.randomUUID(), crypto.randomUUID()];

  for (const artifactId of versions) {
    await environment.database.db.insert(artifacts).values(
      artifact.parse({
        id: artifactId,
        appId: record.id,
        metadata: {
          main_module: "worker.js",
          compatibility_date: "2026-10-01",
          assets: { upload_session: crypto.randomUUID() },
        },
        manifest: {},
        modules: [{ name: "worker.js", type: "esm", sha256: "0".repeat(64), size: 0 }],
      }),
    );
    await environment.database.db.insert(deployments).values({
      id: crypto.randomUUID(),
      appId: record.id,
      artifactId,
      requestId: crypto.randomUUID(),
      status: "succeeded",
      finishedAt: new Date(),
    });
  }

  await page.goto(`/apps/${record.id}?tab=deployments`);
  const rollback = page.getByRole("button", { name: "Restore version", exact: true });
  const requestId = await page.locator('input[name^="requestId/"]').first().inputValue();
  let release: (() => void) | undefined;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route(
    "**/_app/remote/*/rollbackApp",
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );

  try {
    await rollback.first().click();
    await expect(page.getByRole("button", { name: "Requesting restoration …" })).toBeDisabled();
    await expect(rollback).toBeDisabled();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await page
      .getByRole("navigation", { name: "App sections" })
      .getByRole("link", { name: /^Deployments/ })
      .click();
    await expect(page.locator('input[name^="requestId/"]').first()).toHaveValue(requestId);

    const restoredButtons = page
      .getByRole("region", { name: "Deployment history" })
      .getByRole("button");

    await expect(restoredButtons).toHaveCount(2);

    for (const button of await restoredButtons.all()) await expect(button).toBeDisabled();
    await expect(page.getByText("Waiting for agent", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Deployment history" }).getByRole("status"),
    ).toHaveCount(0);
  } finally {
    release?.();
  }

  await expect(
    page.getByRole("region", { name: "Deployment history" }).getByRole("status"),
  ).toContainText("Restoration requested");
  await expect(page.getByText("Waiting for agent", { exact: true })).toHaveCount(1);
  await rollback.last().click();
  await expect(page.getByText("Waiting for agent", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("validates remote forms and creates apps without JavaScript", async ({ browser }) => {
  const session = await environment.users.login({ userId: environment.owner.id });

  const context = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
    javaScriptEnabled: false,
    extraHTTPHeaders: { "x-forwarded-proto": "http" },
  });

  try {
    await context.addCookies(
      session.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        sameSite: "Lax",
        secure: false,
      })),
    );
    const page = await context.newPage();
    const response = await page.goto("/");
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
    await page.getByRole("link", { name: "Create app", exact: true }).click();
    await page.getByLabel("App name", { exact: true }).fill("Native Form App");
    await page.getByLabel("URL slug").fill("auth");
    await page.getByRole("button", { name: "Create app" }).click();
    await expect(page.getByRole("alert")).toContainText("The auth hostname is reserved for SSO");
    await expect(page.getByLabel("App name", { exact: true })).toHaveValue("Native Form App");
    await page.getByLabel("URL slug").fill("native-form-app");
    await page.getByRole("button", { name: "Create app" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Native Form App");
    const parentId = z.uuid().parse(new URL(page.url()).pathname.split("/").at(-1));
    await page.goto("/apps/new");
    await page.getByLabel("App name", { exact: true }).fill("Native Preview");
    await page.getByLabel("URL slug").fill("native-preview");
    await page.getByText("Create as preview", { exact: false }).click();
    await page.getByLabel("Preview of an existing app").selectOption(parentId);
    await page.getByRole("button", { name: "Create app" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Native Preview");
    await page.getByRole("link", { name: "Back to original app" }).click();
    await page.getByRole("link", { name: "App settings", exact: true }).click();
    await page.getByText("Permanently delete app", { exact: true }).click();
    await expect(
      page.getByText("This app, all its previews and their published versions will be removed."),
    ).toBeVisible();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Delete app", exact: true }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Native Form App" })).toContainText(
      "Deleting",
    );
    await expect(page.getByRole("listitem").filter({ hasText: "Native Preview" })).toContainText(
      "Deleting",
    );
  } finally {
    await context.close();
  }
});

test.describe("member forms without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test.beforeEach(async ({ context }) => {
    const admin = environment.users.createUser({
      name: "Native Admin",
      email: `native-admin-${crypto.randomUUID()}@example.test`,
    });

    await environment.users.saveUser(admin);
    await environment.linkMicrosoftUser(admin.id);
    await environment.database.db
      .update(member)
      .set({ role: "admin" })
      .where(eq(member.userId, admin.id));
    const session = await environment.users.login({ userId: admin.id });
    await context.addCookies(
      session.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        sameSite: "Lax",
        secure: false,
      })),
    );
  });

  test("preserves role search and pagination after successful and rejected changes", async ({
    page,
  }) => {
    for (let index = 0; index < 50; index += 1) {
      const person = environment.users.createUser({
        name: `Native Role ${String(index).padStart(2, "0")}`,
        email: `native-role-${index}@example.test`,
      });

      await environment.users.saveUser(person);
      await environment.linkMicrosoftUser(person.id);
    }

    const target = environment.users.createUser({
      name: "Native Role Target",
      email: "native-role-target@example.test",
    });

    await environment.users.saveUser(target);
    await environment.linkMicrosoftUser(target.id);
    await page.goto("/members?q=Native+Role&page=2");
    const form = page.getByRole("form", { name: "Role for Native Role Target" });
    await form.getByLabel("Role", { exact: true }).selectOption("admin");
    await form.getByRole("button", { name: "Save role" }).click();
    await expect(page.getByRole("status")).toContainText("Role saved");
    await expect(page.getByLabel("Search by name or email")).toHaveValue("Native Role");
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("q")).toBe("Native Role");
    expect(new URL(page.url()).searchParams.get("page")).toBe("2");

    // Tamper with the native form; application JavaScript remains disabled.
    await form.getByLabel("Role", { exact: true }).evaluate((select: HTMLSelectElement) => {
      select.add(new Option("Owner", "owner"));
      select.value = "owner";
    });
    await form.getByRole("button", { name: "Save role" }).click();
    await expect(page.getByRole("alert")).toContainText("Only owners can appoint");
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByLabel("Search by name or email")).toHaveValue("Native Role");
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("q")).toBe("Native Role");
    expect(new URL(page.url()).searchParams.get("page")).toBe("2");
    expect(
      await environment.database.db
        .select({ role: member.role })
        .from(member)
        .where(eq(member.userId, target.id)),
    ).toEqual([{ role: "admin" }]);
  });

  test("preserves role search and rejected native form submissions", async ({ page, context }) => {
    const person = environment.users.createUser({
      name: "Native Grant User",
      email: "native-grant@example.test",
    });

    await environment.users.saveUser(person);
    await environment.linkMicrosoftUser(person.id);

    const created = await context.request.post("/api/v1/apps", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { slug: "native-access", displayName: "Native Access" },
    });

    expect(created.ok()).toBe(true);
    const record = app.parse(await created.json());
    const path = `/apps/${record.id}?q=native-grant`;
    await page.goto(path);
    await page.getByRole("button", { name: "Grant access" }).click();
    await expect(page.locator("#access").getByRole("status")).toHaveText("App access saved.");
    expect(new URL(page.url()).searchParams.get("q")).toBe("native-grant");

    const revoke = page.locator("form").filter({
      has: page.getByRole("button", { name: "Revoke access" }),
    });

    await revoke.locator('input[name^="assignmentId/"]').evaluate((input: HTMLInputElement) => {
      input.value = "";
    });
    await revoke.getByRole("button").click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("#access").getByRole("status")).toHaveCount(0);
    await expect(page.getByLabel("Find a member by name or email")).toHaveValue("native-grant");
    expect(
      await environment.database.db
        .select({ subject: appRoleAssignments.subject, role: appRoleAssignments.role })
        .from(appRoleAssignments)
        .where(eq(appRoleAssignments.appId, record.id)),
    ).toEqual(expect.arrayContaining([{ subject: person.id, role: "developer" }]));
    await page.goto(path);
    await page.getByRole("button", { name: "Revoke access" }).click();
    await expect(page.locator("#access").getByRole("status")).toHaveText("App access saved.");
    expect(new URL(page.url()).searchParams.get("q")).toBe("native-grant");

    const grant = page.locator("form").filter({
      has: page.getByRole("button", { name: "Grant access" }),
    });

    await grant.locator('input[name^="subject/"]').evaluate((input: HTMLInputElement) => {
      input.value = "missing-user";
    });
    await grant.getByRole("button").click();
    await expect(page.getByRole("alert")).toHaveText("An active company user is required");
    await expect(page.locator("#access").getByRole("status")).toHaveCount(0);
    await expect(page.getByLabel("Find a member by name or email")).toHaveValue("native-grant");
    expect(new URL(page.url()).searchParams.get("q")).toBe("native-grant");
    expect(
      await environment.database.db
        .select()
        .from(appRoleAssignments)
        .where(eq(appRoleAssignments.appId, record.id)),
    ).toHaveLength(1);

    await page.goto(path);
    await page.getByText("Native Grant User als Owner einsetzen", { exact: true }).click();
    await page.getByRole("button", { name: "An Native Grant User übertragen" }).click();
    await expect(page).toHaveURL("/");
    expect(
      await environment.database.db
        .select({ role: appRoleAssignments.role, subject: appRoleAssignments.subject })
        .from(appRoleAssignments)
        .where(eq(appRoleAssignments.appId, record.id)),
    ).toEqual([{ role: "owner", subject: person.id }]);
  });
});

for (const javaScriptEnabled of [true, false]) {
  test.describe(`app catalog with JavaScript ${javaScriptEnabled ? "enabled" : "disabled"}`, () => {
    test.use({ javaScriptEnabled });

    test("publishes and withdraws apps for members without granting management access", async ({
      page,
      context,
      browser,
      request,
    }) => {
      await page.goto("/catalog");
      await expect(page).toHaveURL(/\/sign-in\?next=/);
      expect(new URL(page.url()).searchParams.get("next")).toBe("/catalog");

      const creator = environment.users.createUser({
        name: "Catalog Creator",
        email: `catalog-creator-${javaScriptEnabled}@example.test`,
      });

      const reader = environment.users.createUser({
        name: "Catalog Reader",
        email: `catalog-reader-${javaScriptEnabled}@example.test`,
      });

      for (const person of [creator, reader]) {
        await environment.users.saveUser(person);
        await environment.linkMicrosoftUser(person.id);
      }

      const creatorSession = await environment.users.login({ userId: creator.id });
      await context.addCookies(
        creatorSession.cookies.map((cookie) => ({
          ...cookie,
          domain: "localhost",
          sameSite: "Lax",
          secure: false,
        })),
      );

      const origin = environment.configuration.PLATFORM_URL;

      const created = await context.request.post("/api/v1/apps", {
        headers: { origin },
        data: {
          slug: `catalog-${javaScriptEnabled}`,
          displayName: `Catalog App ${javaScriptEnabled}`,
        },
      });

      expect(created.ok()).toBe(true);
      const record = app.parse(await created.json());
      expect(record.catalogListed).toBe(false);
      await environment.database.db
        .update(apps)
        .set({ state: "active", activeDeploymentId: crypto.randomUUID() })
        .where(eq(apps.id, record.id));

      const readerContext = await browser.newContext({
        baseURL: origin,
        javaScriptEnabled,
        extraHTTPHeaders: { "x-forwarded-proto": "http" },
      });

      try {
        const readerSession = await environment.users.login({ userId: reader.id });
        await readerContext.addCookies(
          readerSession.cookies.map((cookie) => ({
            ...cookie,
            domain: "localhost",
            sameSite: "Lax",
            secure: false,
          })),
        );
        const readerPage = await readerContext.newPage();
        await readerPage.goto("/");
        await expect(
          readerPage.getByRole("link", { name: "Create app", exact: true }),
        ).toBeVisible();
        await readerPage.getByRole("link", { name: "App catalog", exact: true }).click();
        await expect(readerPage.getByRole("heading", { level: 1 })).toHaveText("App catalog");
        await expect(readerPage.getByRole("link", { name: record.displayName })).toHaveCount(0);

        await page.goto(`/apps/${record.id}?tab=settings`);

        const publish = page.getByRole("button", {
          name: "Publish to catalog",
          exact: true,
        });

        const form = page.locator("form").filter({ has: publish });
        const action = z.string().parse(await form.getAttribute("action"));
        const remote = z.string().parse(new URL(action, origin).searchParams.get("/remote"));
        const queryUrl = `/_app/remote/${remote.split("/")[0]}/getCatalog`;
        const anonymous = await request.get(queryUrl);
        expect(await anonymous.json()).toMatchObject({ type: "error", error: { status: 401 } });

        const fields = await form.evaluate((element) =>
          Object.fromEntries(
            Array.from(element.querySelectorAll("input"), (input) => [input.name, input.value]),
          ),
        );

        const forged = await readerContext.request.post(`/_app/remote/${remote}`, {
          headers: { origin },
          form: fields,
        });

        expect(await forged.text(), logs).toContain("issues");
        expect(
          await environment.database.db
            .select({ catalogListed: apps.catalogListed })
            .from(apps)
            .where(eq(apps.id, record.id)),
        ).toEqual([{ catalogListed: false }]);

        await publish.click();
        await expect(
          page.getByRole("button", { name: "Remove from catalog", exact: true }),
        ).toBeVisible();
        await readerPage.reload();
        await expect(readerPage.getByRole("link", { name: record.displayName })).toHaveAttribute(
          "href",
          record.url,
        );
        expect((await readerContext.request.get(`/apps/${record.id}`)).status()).toBe(404);
        expect((await readerContext.request.get(`/api/v1/apps/${record.id}`)).status()).toBe(404);
        const catalog = await readerContext.request.get(queryUrl);
        expect(catalog.headers()["cache-control"]).toBe("private, no-store");
        expect(await catalog.text()).toContain(record.displayName);

        await page.getByRole("button", { name: "Remove from catalog", exact: true }).click();
        await expect(publish).toBeVisible();
        await readerPage.reload();
        await expect(readerPage.getByRole("link", { name: record.displayName })).toHaveCount(0);
      } finally {
        await readerContext.close();
      }
    });
  });
}

test("remote endpoints recheck sessions, roles, input and request origin", async ({
  page,
  context,
  request,
}) => {
  const person = environment.users.createUser({
    name: "Remote Admin",
    email: "remote-admin@example.test",
  });

  await environment.users.saveUser(person);
  await environment.linkMicrosoftUser(person.id);
  await environment.database.db
    .update(member)
    .set({ role: "admin" })
    .where(eq(member.userId, person.id));
  const session = await environment.users.login({ userId: person.id });
  await context.addCookies(
    session.cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      sameSite: "Lax",
      secure: false,
    })),
  );
  await page.goto("/agents");
  await page.getByText("Register deployment agent", { exact: true }).click();
  const form = page.locator("form").filter({ has: page.getByLabel("Agent name", { exact: true }) });

  const fieldName = z
    .string()
    .parse(await form.getByLabel("Agent name", { exact: true }).getAttribute("name"));

  const action = z.string().parse(await form.getAttribute("action"));

  const remote = z
    .string()
    .parse(new URL(action, environment.configuration.PLATFORM_URL).searchParams.get("/remote"));

  const module = remote.split("/")[0];
  const queryUrl = `/_app/remote/${module}/getApps`;
  const formUrl = `/_app/remote/${remote}`;
  const origin = environment.configuration.PLATFORM_URL;
  const ownerSession = await environment.users.login({ userId: environment.owner.id });

  const fixture = await request.post("/api/v1/apps", {
    headers: { origin, cookie: z.string().parse(new Headers(ownerSession.headers).get("cookie")) },
    data: { slug: "remote-private-app", displayName: "Private remote fixture" },
  });

  expect(fixture.ok()).toBe(true);

  const anonymous = await request.get(queryUrl);
  expect(anonymous.headers()["cache-control"]).toBe("private, no-store");
  expect(await anonymous.json()).toMatchObject({ type: "error", error: { status: 401 } });
  const authenticated = await context.request.get(queryUrl);
  expect(await authenticated.json()).toMatchObject({ type: "result" });
  expect(await authenticated.text()).toContain("remote-private-app");

  const before = await environment.database.db.select().from(agents);

  const foreignOrigin = await context.request.post(formUrl, {
    form: { [fieldName]: "Forged Agent" },
    headers: { origin: "https://other.example.test" },
  });

  expect(foreignOrigin.status()).toBe(403);

  const missingOrigin = await context.request.post(formUrl, {
    form: { [fieldName]: "Forged Agent" },
  });

  expect(missingOrigin.status()).toBe(403);

  const invalidInput = await context.request.post(formUrl, {
    form: { [fieldName]: "" },
    headers: { origin },
  });

  expect(await invalidInput.text()).toContain("issues");

  await environment.database.db
    .update(member)
    .set({ role: "member" })
    .where(eq(member.userId, person.id));

  const denied = await context.request.post(formUrl, {
    form: { [fieldName]: "Forged Agent" },
    headers: { origin },
  });

  expect(await denied.text()).toContain("issues");
  expect(await environment.database.db.select().from(agents)).toEqual(before);
  const visible = await context.request.get(queryUrl);
  const otherApps = await environment.database.db.select().from(apps);
  expect(otherApps.length).toBeGreaterThan(0);
  const body = await visible.text();

  for (const app of otherApps) expect(body).not.toContain(app.slug);

  await environment.database.db.delete(member).where(eq(member.userId, person.id));
  const expired = await context.request.get(queryUrl);
  expect(await expired.json()).toMatchObject({ type: "error", error: { status: 401 } });
});

for (const javaScriptEnabled of [true, false]) {
  test(`edits app and inherited preview access with JavaScript ${javaScriptEnabled}`, async ({
    browser,
  }) => {
    const [owner] = await environment.database.db
      .select()
      .from(member)
      .where(eq(member.role, "owner"));

    if (!owner) throw new Error("Expected initial owner");
    const session = await environment.users.login({ userId: owner.userId });

    const context = await browser.newContext({
      baseURL: environment.configuration.PLATFORM_URL,
      extraHTTPHeaders: { "x-forwarded-proto": "http" },
      javaScriptEnabled,
    });

    try {
      await context.addCookies(
        session.cookies.map((cookie) => ({
          ...cookie,
          domain: "localhost",
          sameSite: "Lax",
          secure: false,
        })),
      );
      const slug = `access-ui-${javaScriptEnabled ? "js" : "html"}`;

      const create = await context.request.post("/api/v1/apps", {
        headers: { origin: environment.configuration.PLATFORM_URL },
        data: { slug, displayName: "Access fixture", parentId: null },
      });

      expect(create.status()).toBe(200);
      const parent = app.parse(await create.json());
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const hydration = new EventEmitter();
      const ready = once(hydration, "ready");

      if (javaScriptEnabled)
        await page.route(
          "**/_app/immutable/entry/start.*.js",
          async (route) => {
            await ready;
            await route.continue();
          },
          { times: 1 },
        );

      await page.goto(`/apps/${parent.id}?tab=access&scope=app`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Allowed groups for this app", { exact: true }).fill("finance");
      hydration.emit("ready");

      // Finish loading the held client scripts after editing the server-rendered form.
      if (javaScriptEnabled) await page.waitForLoadState("networkidle");
      await expect(page.getByLabel("Allowed groups for this app", { exact: true })).toHaveValue(
        "finance",
      );

      const submission = new EventEmitter();
      const resume = once(submission, "resume");

      if (javaScriptEnabled)
        await page.route(
          "**/*changeAppAccess*",
          async (route) => {
            await resume;
            await route.continue();
          },
          { times: 1 },
        );

      await page.getByRole("button", { name: "Save app rules", exact: true }).click();

      if (javaScriptEnabled) {
        try {
          await expect(
            page.getByLabel("Allowed groups for this app", { exact: true }),
          ).toBeDisabled();
          await expect(page.getByRole("button", { name: "Saving …", exact: true })).toBeDisabled();
        } finally {
          submission.emit("resume");
        }
      }

      await expect
        .poll(async () => {
          const response = await context.request.get(`/api/v1/apps/${parent.id}/access`);

          return z.object({ allAuthenticated: z.boolean() }).parse(await response.json())
            .allAuthenticated;
        })
        .toEqual(["finance"]);
      await expect(page.getByLabel("Allowed groups for this app", { exact: true })).toHaveValue(
        "finance",
      );
      await expect(page.getByRole("button", { name: "Save app rules", exact: true })).toBeEnabled();

      await expect(page.getByLabel("Allowed groups for all previews")).toHaveCount(0);

      const previewResponse = await context.request.post("/api/v1/apps", {
        headers: { origin: environment.configuration.PLATFORM_URL },
        data: {
          slug: `${slug}-review`,
          displayName: "Preview fixture",
          parentId: parent.id,
          previewName: "review",
        },
      });

      const preview = app.parse(await previewResponse.json());
      await page.goto(`/apps/${preview.id}?tab=access&scope=app`);
      await expect(
        page.getByText(
          "This preview automatically inherits the original app's access rules. You cannot set separate rules.",
        ),
      ).toBeVisible();
      await expect(page.getByText("Allowed groups: finance", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save app rules", exact: true })).toHaveCount(
        0,
      );
      // This phase edits the hydrated form; the first visit covers pre-hydration input.
      await page.goto(`/apps/${parent.id}?tab=access&scope=app`, { waitUntil: "networkidle" });
      await page.getByLabel("Allowed groups for this app", { exact: true }).fill("unsaved-group");

      const competing = await context.request.patch(`/api/v1/apps/${parent.id}/access`, {
        headers: { origin: environment.configuration.PLATFORM_URL },
        data: { allAuthenticated: false, revision: 2 },
      });

      expect(competing.status()).toBe(200);

      if (javaScriptEnabled) {
        await page.getByRole("link", { name: "Management access", exact: true }).click();
        await page.getByRole("link", { name: "App usage", exact: true }).click();
        await expect(page.getByLabel("Allowed groups for this app", { exact: true })).toHaveValue(
          "unsaved-group",
        );
        await page.getByRole("link", { name: "Overview", exact: true }).click();
        await page.getByRole("link", { name: "Access", exact: true }).click();
        await expect(page.getByLabel("Allowed groups for this app", { exact: true })).toHaveValue(
          "unsaved-group",
        );

        const refreshed = page.waitForResponse((response) =>
          response.url().includes("/getAppAccess"),
        );

        await page.getByRole("link", { name: "Refresh status", exact: true }).click();
        await refreshed;
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const submitted = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" && response.url().includes("changeAppAccess"),
        );

        await page.getByRole("button", { name: "Save app rules", exact: true }).click();
        await submitted;
        await expect(page.getByRole("alert")).toContainText("Access rules have changed");
        await expect(page.getByLabel("Allowed groups for this app", { exact: true })).toHaveValue(
          "unsaved-group",
        );
        const response = await context.request.get(`/api/v1/apps/${parent.id}/access`);
        expect(await response.json()).toMatchObject({ allAuthenticated: false, revision: 3 });
      }

      await page.getByRole("link", { name: "Discard draft and reload rules", exact: true }).click();
      await expect(page.getByLabel("Allowed groups for this app", { exact: true })).toHaveValue(
        "qa",
      );
      await page.getByLabel("Allowed groups for this app", { exact: true }).fill("");
      await page.getByRole("button", { name: "Save app rules", exact: true }).click();
      await expect
        .poll(async () => {
          const response = await context.request.get(`/api/v1/apps/${preview.id}/access`);

          return z.object({ allAuthenticated: z.boolean() }).parse(await response.json())
            .allAuthenticated;
        })
        .toEqual([]);
      await page.goto(`/apps/${preview.id}?tab=access&scope=app`);
      await expect(
        page.getByText("Allowed groups: All signed-in users", { exact: true }),
      ).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test.describe("workspace experience", () => {
  test.beforeEach(async ({ context }) => {
    const session = await environment.users.login({ userId: environment.owner.id });

    await context.addCookies(
      session.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        sameSite: "Lax",
        secure: false,
      })),
    );
  });

  test("searches apps, preserves filters in URLs, and returns to an app's access section", async ({
    page,
    context,
  }) => {
    const response = await context.request.post("/api/v1/apps", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { slug: "experience-search", displayName: "Searchable Workspace" },
    });

    expect(response.ok()).toBe(true);
    const record = app.parse(await response.json());
    await page.goto("/");
    await expect(page.getByLabel("App name", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Agent name", { exact: true })).toHaveCount(0);
    await page.getByRole("search").getByRole("searchbox").fill("searchable");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("list", { name: "Apps" }).getByRole("listitem")).toHaveCount(1);
    await page
      .getByRole("navigation", { name: "Filter apps" })
      .getByRole("link", { name: "Active", exact: true })
      .click();
    expect(new URL(page.url()).searchParams.get("q")).toBe("searchable");
    await expect(page.getByRole("heading", { name: "No matching apps" })).toBeVisible();
    await page.goBack();
    await page.getByRole("link", { name: "Searchable Workspace", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Ready for your first deployment." }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Access", exact: true }).click();
    await page.getByRole("link", { name: "Management access", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/apps/${record.id}\\?tab=access&scope=management$`));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Manage access" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Access", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("keeps mobile navigation usable without horizontal page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByText("Menu", { exact: true }).click();
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Members", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.getByText("Menu", { exact: true }).click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.goto("/apps/new");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.getByText("Create as preview", { exact: false }).click();
    await expect(page.getByLabel("Preview of an existing app")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });

  test("supports keyboard navigation, saved appearance, and copying an exact deployment command", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    const response = await context.request.post("/api/v1/apps", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { slug: "experience-keyboard", displayName: "Keyboard Workspace" },
    });

    const record = app.parse(await response.json());
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    const accountMenu = page.getByRole("button", { name: /^Account:/ });
    await accountMenu.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(accountMenu).toBeFocused();
    await accountMenu.click();
    await page.getByRole("menuitem", { name: "Dark appearance", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.goto(`/apps/${record.id}`);
    await page.getByRole("button", { name: "Copy deployment command", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`widefleet --url '${environment.configuration.PLATFORM_URL}' deploy ${record.id}`);
    await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  });

  test("reconciles deployment completion and reports refresh failures without losing the last result", async ({
    page,
    context,
  }) => {
    const response = await context.request.post("/api/v1/apps", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { slug: "experience-live", displayName: "Live Workspace" },
    });

    const record = app.parse(await response.json());
    const artifactId = crypto.randomUUID();
    const deploymentId = crypto.randomUUID();

    await environment.database.db.insert(artifacts).values(
      artifact.parse({
        id: artifactId,
        appId: record.id,
        metadata: {
          main_module: "worker.js",
          compatibility_date: "2026-10-01",
          assets: { upload_session: crypto.randomUUID() },
        },
        manifest: {},
        modules: [{ name: "worker.js", type: "esm", sha256: "0".repeat(64), size: 0 }],
      }),
    );
    await environment.database.db.insert(deployments).values({
      id: deploymentId,
      appId: record.id,
      artifactId,
      requestId: crypto.randomUUID(),
      status: "running",
    });
    await page.goto(`/apps/${record.id}?tab=deployments`);
    await expect(page.getByText("Deploying", { exact: true })).toBeVisible();
    await environment.database.db
      .update(deployments)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));
    await environment.database.db
      .update(apps)
      .set({ state: "active", activeDeploymentId: deploymentId })
      .where(eq(apps.id, record.id));
    await expect(page.getByText("Current version", { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole("link", { name: "Open app", exact: true })).toBeVisible();
    await page.route("**/_app/remote/**", (route) => route.abort());
    await page.getByRole("button", { name: "Refresh app", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Could not refresh the status");
    await expect(page.getByText("Current version", { exact: true })).toBeVisible();
    await page.unroute("**/_app/remote/**");
    await page.getByRole("button", { name: "Refresh app", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.route("**/_app/remote/**", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ type: "error", error: { message: "Access revoked" } }),
      }),
    );
    await page.getByRole("button", { name: "Refresh app", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "You don't have access to this page." }),
    ).toBeVisible();
    await expect(page.getByText("Current version", { exact: true })).toHaveCount(0);
  });

  test("preserves a newly registered agent key when refreshing the list fails", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/agents");

    const previousAgents = await page
      .getByRole("list", { name: "Deployment agents" })
      .getByRole("listitem")
      .allTextContents();

    await page.getByText("Register deployment agent", { exact: true }).click();
    await page.getByLabel("Agent name", { exact: true }).fill("Resilient Agent");
    await page.route("**/_app/remote/*/getAgents*", (route) => route.abort());
    await page.getByRole("button", { name: "Register agent", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Could not refresh the agent list");
    await expect(
      page.getByRole("heading", { name: "Agent Resilient Agent registered" }),
    ).toBeVisible();
    const credential = page.locator("code[data-private]");
    await expect(credential).toHaveText(/^agent_/);
    const token = await credential.innerText();
    expect(
      await page
        .getByRole("list", { name: "Deployment agents" })
        .getByRole("listitem")
        .allTextContents(),
    ).toEqual(previousAgents);
    await page.getByRole("button", { name: "Copy agent key", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(token);
    await page.unroute("**/_app/remote/*/getAgents*");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("listitem").filter({ hasText: "Resilient Agent" })).toBeVisible();
    await expect(credential).toHaveText(token);
    expect(
      await environment.database.db.select().from(agents).where(eq(agents.name, "Resilient Agent")),
    ).toHaveLength(1);
  });

  test("rejects unavailable preview parents instead of creating independent apps", async ({
    page,
    context,
  }) => {
    const created = await context.request.post("/api/v1/apps", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { slug: "preview-parent-check", displayName: "Preview Parent" },
    });

    expect(created.ok()).toBe(true);
    const parent = app.parse(await created.json());

    const createdPreview = await context.request.post("/api/v1/apps", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: {
        slug: "preview-child-check",
        displayName: "Preview Child",
        parentId: parent.id,
        previewName: "review",
      },
    });

    expect(createdPreview.ok()).toBe(true);
    const preview = app.parse(await createdPreview.json());
    await page.goto(`/apps/new?parent=${parent.id}`);
    await expect(page.getByLabel("Preview of an existing app")).toHaveValue(parent.id);

    const removed = await context.request.delete(`/api/v1/apps/${parent.id}`, {
      headers: { origin: environment.configuration.PLATFORM_URL },
    });

    expect(removed.ok()).toBe(true);

    for (const parentId of [parent.id, preview.id, crypto.randomUUID(), ""]) {
      const response = await page.goto(`/apps/new?parent=${parentId}`);
      expect(response?.status()).toBe(404);
      await expect(page.getByLabel("App name", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Back to overview", exact: true })).toBeVisible();
    }

    await page.goto("/apps/new");
    await expect(page.getByLabel("App name", { exact: true })).toBeVisible();
  });

  test("registers and disables an agent with native forms", async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: environment.configuration.PLATFORM_URL,
      javaScriptEnabled: false,
      extraHTTPHeaders: { "x-forwarded-proto": "http" },
    });

    const session = await environment.users.login({ userId: environment.owner.id });

    try {
      await context.addCookies(
        session.cookies.map((cookie) => ({
          ...cookie,
          domain: "localhost",
          sameSite: "Lax",
          secure: false,
        })),
      );
      const page = await context.newPage();
      await page.goto("/agents");
      await page.getByText("Register deployment agent", { exact: true }).click();
      await page.getByLabel("Agent name", { exact: true }).fill("   ");
      await page.getByRole("button", { name: "Register agent", exact: true }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByLabel("Agent name", { exact: true })).toBeVisible();
      await page.getByLabel("Agent name", { exact: true }).fill("Native Agent");
      await page.getByRole("button", { name: "Register agent", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("agent_");
      const row = page.getByRole("listitem").filter({ hasText: "Native Agent" });
      await row.getByText("Disable agent", { exact: true }).click();
      await row.getByRole("button", { name: "Confirm deactivation", exact: true }).click();
      await expect(row.getByText("Disabled", { exact: true })).toBeVisible();
      await expect(page.getByRole("status")).not.toContainText("agent_");
      await expect(
        row.getByRole("button", { name: "Confirm deactivation", exact: true }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
