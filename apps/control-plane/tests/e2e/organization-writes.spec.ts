import { expect, test, type Browser } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { member, organization, session } from "../../src/lib/server/auth-schema.ts";
import { apps, artifacts, deployments, organizationRuntimes } from "../../src/lib/server/schema.ts";
import { hashAsset } from "../../src/lib/server/asset-hash.ts";
import { workerMetadata } from "@platform/contracts";
import { seedDeployment } from "../cloudflare-deployment.fixture.ts";
import { storedAppSecrets } from "../../src/lib/server/app-secrets.ts";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createTestEnvironment } from "../environment.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let server: ReturnType<typeof spawn>;

let logs = "";

let storage: S3Client;

test.setTimeout(60_000);

test.beforeAll(async () => {
  environment = await createTestEnvironment();
  environment.environment.S3_BUCKET = `test-${crypto.randomUUID()}`;
  storage = new S3Client({
    endpoint: "http://localhost:25400",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: environment.environment.S3_ACCESS_KEY_ID,
      secretAccessKey: environment.environment.S3_SECRET_ACCESS_KEY,
    },
  });
  await storage.send(new CreateBucketCommand({ Bucket: environment.environment.S3_BUCKET }));
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

  if (storage) {
    const Bucket = environment.environment.S3_BUCKET;
    const contents = await storage.send(new ListObjectsV2Command({ Bucket }));

    if (contents.Contents?.length)
      await storage.send(
        new DeleteObjectsCommand({
          Bucket,
          Delete: { Objects: contents.Contents.map(({ Key }) => ({ Key: Key ?? "" })) },
        }),
      );
    await storage.send(new DeleteBucketCommand({ Bucket }));
    storage.destroy();
  }

  await environment?.close();
});

test.afterEach(async ({ browserName }, info) => {
  if (info.status !== info.expectedStatus)
    await info.attach(`${browserName}-server-log`, { body: logs, contentType: "text/plain" });
});

const organizationSession = async (browser: Browser) => {
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
    await environment.database.db.insert(organizationRuntimes).values({
      organizationId: id,
      appHostnameSuffix: id,
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

test("confirms browser worker access before changing organization security", async ({
  browser,
}) => {
  const { alpha, context } = await organizationSession(browser);

  try {
    const page = await context.newPage();
    await page.goto(`/${alpha}/settings/security`);
    await page.waitForLoadState("networkidle");
    const control = page.getByRole("switch", { name: "Browser workers" });
    await expect(control).not.toBeChecked();
    await control.click();
    const dialog = page.getByRole("dialog", { name: "Allow browser workers?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(control).toBeFocused();
    await expect(control).not.toBeChecked();
    await control.press("Space");
    await dialog.getByRole("button", { name: "Allow browser workers" }).click();
    await expect(control).toBeChecked();
    await expect(control).toBeEnabled();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(control).toBeChecked();
    await control.click();
    await expect(control).not.toBeChecked();
    await expect(control).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("explains a locked browser worker switch on hover and keyboard focus", async ({ browser }) => {
  const { alpha, context } = await organizationSession(browser);

  try {
    const page = await context.newPage();
    await page.goto(`/${alpha}/settings/administration`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Manage settings externally" }).click();
    await expect(page.getByRole("button", { name: "Enable browser editing" })).toBeVisible();
    await page.goto(`/${alpha}/settings/security`);
    await page.waitForLoadState("networkidle");
    const locked = page.getByRole("group", { name: "Browser workers, externally managed" });
    const tooltip = page.getByRole("tooltip");
    await expect(locked.getByRole("switch")).toBeDisabled();
    await expect(tooltip).toBeHidden();
    await locked.hover();
    await expect(tooltip).toHaveText("Managed through the API or CLI.");
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();
    await locked.focus();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
  } finally {
    await context.close();
  }
});

test("opens organization settings without installation reporting privileges", async ({
  browser,
}) => {
  const { alpha, context } = await organizationSession(browser);

  try {
    const page = await context.newPage();
    const response = await page.goto(`/${alpha}/settings/company-sign-in`);

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Company sign-in", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy", exact: true })).toHaveCount(0);

    const current = await context.request.get("/api/v1/me", {
      headers: { "x-widefleet-organization": alpha },
    });

    expect(await current.json()).toMatchObject({
      admin: false,
      application: { organizationId: alpha, admin: true },
    });
  } finally {
    await context.close();
  }
});

test("asks which organization an MCP client connects and returns with it", async ({ browser }) => {
  const { beta, context } = await organizationSession(browser);

  try {
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const signIn = `/mcp/sign-in?${new URLSearchParams({ state })}`;

    const response = await context.request.get(signIn, { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    const chooser = new URL(response.headers()["location"] ?? "invalid", "http://localhost");
    expect(chooser.pathname).toBe("/organizations");
    expect(chooser.searchParams.get("next")).toBe(`${signIn}&organization=[organization]`);

    // An organization the person cannot open asks again instead of connecting.
    const foreign = await context.request.get(`${signIn}&organization=unknown`, {
      maxRedirects: 0,
    });

    expect(new URL(foreign.headers()["location"] ?? "invalid", "http://localhost").pathname).toBe(
      "/organizations",
    );

    const page = await context.newPage();
    await page.goto(signIn);
    await expect(
      page.getByText("Choose the organization whose apps you want to connect."),
    ).toBeVisible();

    // Routes do not intercept redirected requests; observe the data-plane request instead.
    const reached = page.waitForRequest((request) =>
      request.url().startsWith("https://mcp.apps.localhost/"),
    );

    await page.getByRole("link", { name: /Beta/ }).click();

    const target = new URL((await reached).url());
    expect(target.pathname).toBe("/oauth/organization");
    expect(Object.fromEntries(target.searchParams)).toEqual({ state, organization: beta });
  } finally {
    await context.close();
  }
});

test("returns MCP sign-in directly for a person with one organization", async ({ browser }) => {
  const { person, alpha, beta, context } = await organizationSession(browser);

  try {
    await environment.database.db
      .delete(member)
      .where(and(eq(member.userId, person.id), eq(member.organizationId, beta)));
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

    const response = await context.request.get(`/mcp/sign-in?${new URLSearchParams({ state })}`, {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(303);
    const target = new URL(response.headers()["location"] ?? "invalid");
    expect(target.origin).toBe("https://mcp.apps.localhost");
    expect(target.pathname).toBe("/oauth/organization");
    expect(target.searchParams.get("state")).toBe(state);
    expect(target.searchParams.get("organization")).toBe(alpha);
  } finally {
    await context.close();
  }
});

test(`preserves multiline secrets and offers failed disconnection retries`, async ({ browser }) => {
  const { person, alpha, context } = await organizationSession(browser);

  try {
    const id = crypto.randomUUID();
    await environment.database.db.insert(apps).values({
      id,
      organizationId: alpha,
      ownerId: person.id,
      slug: "service-consumer",
      displayName: "Service consumer",
      hostname: `service-consumer-${alpha}.apps.localhost`,
    });
    const page = await context.newPage();
    await page.goto(`/${alpha}/apps/${id}/secrets`);
    const value = "-----BEGIN FIXTURE-----\nfirst line\nsecond line\n-----END FIXTURE-----";
    await page.getByLabel("Name", { exact: true }).fill("TOKEN");
    await page.getByLabel("Value", { exact: true }).fill(value);
    await page.getByRole("button", { name: "Save secret", exact: true }).click();
    await expect(page.getByText("TOKEN", { exact: true })).toBeVisible();
    const [saved] = await environment.database.db.select().from(apps).where(eq(apps.id, id));
    const encrypted = storedAppSecrets.parse(saved?.secrets)["TOKEN"];

    if (!encrypted) throw new Error("Missing saved secret");
    expect(
      await environment.encryption.decrypt(
        { kind: "app-secret", organizationId: alpha, appId: id, name: "TOKEN" },
        encrypted,
      ),
    ).toBe(value.replaceAll("\n", "\r\n"));
    const entry = await seedDeployment(environment.database.db, { appId: id, bindings: [] });
    await environment.database.db.insert(deployments).values({
      id: entry.command.id,
      appId: id,
      artifactId: entry.artifact.id,
      status: "succeeded",
      requestId: crypto.randomUUID(),
    });
    await environment.database.db
      .update(apps)
      .set({
        activeDeploymentId: entry.command.id,
        capabilityRevision: 2,
        appliedCapabilityRevision: 1,
        appliedCapabilities: {
          revision: 1,
          grants: { API: { app: crypto.randomUUID(), entrypoint: "Reader" } },
        },
        capabilityError: "Synthetic disconnection failure",
      })
      .where(eq(apps.id, id));
    await page.goto(`/${alpha}/apps/${id}/connections`);

    await page.waitForLoadState("networkidle");
    await page.locator("summary").filter({ hasText: "API" }).click();
    await page.getByRole("button", { name: "Retry disconnection", exact: true }).click();
    await expect(page).toHaveURL(
      `${environment.configuration.PLATFORM_URL}/${alpha}/apps/${id}/connections`,
    );
    // The URL is unchanged by this form. Wait for the mutation's result before
    // reloading, otherwise navigation can cancel the enhanced form request.
    await expect(
      page.getByRole("button", {
        name: "Removal pending",
        exact: true,
        includeHidden: true,
      }),
    ).toBeDisabled();
    await page.reload();
    await page.locator("summary").filter({ hasText: "API" }).click();
    await expect(page.getByRole("button", { name: "Removal pending", exact: true })).toBeDisabled();
    const [retried] = await environment.database.db.select().from(apps).where(eq(apps.id, id));
    expect(retried).toMatchObject({
      capabilities: {},
      capabilityError: null,
      capabilityRevision: 2,
    });
  } finally {
    await context.close();
  }
});

test(`opens the only organization without visiting the chooser`, async ({ browser }) => {
  const { person, alpha, beta, context } = await organizationSession(browser);
  await environment.database.db
    .delete(member)
    .where(and(eq(member.userId, person.id), eq(member.organizationId, beta)));

  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(`${environment.configuration.PLATFORM_URL}/${alpha}`);
    await expect(page.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test(`renames an app in the organization a tab shows while another tab opens another`, async ({
  browser,
}) => {
  const { person, alpha, beta, context } = await organizationSession(browser);

  try {
    const id = crypto.randomUUID();
    await environment.database.db.insert(apps).values({
      id,
      organizationId: alpha,
      ownerId: person.id,
      slug: "parallel",
      displayName: "Parallel",
      hostname: `parallel-${alpha}.apps.localhost`,
    });
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto(`/${alpha}/apps/${id}`);
    await expect(first.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
    await first.waitForLoadState("networkidle");
    await first.getByRole("button", { name: "Edit name" }).click();
    const name = first.getByRole("textbox", { name: "Name", exact: true });
    await expect(
      first.locator("form", { has: name }).locator('input[name^="organizationId/"]'),
    ).toHaveValue(alpha);
    await name.fill("Alpha tab app");

    await second.goto(`/${beta}`);
    await expect(second.getByRole("link", { name: "Choose organization: Beta" })).toBeVisible();

    await name.press("Enter");
    await expect(first.getByRole("heading", { level: 1 })).toHaveText("Alpha tab app");

    const records = await environment.database.db
      .select({ displayName: apps.displayName })
      .from(apps)
      .where(eq(apps.id, id));

    expect(records).toEqual([{ displayName: "Alpha tab app" }]);
  } finally {
    await context.close();
  }
});

for (const activeOrganizationId of [null, "unavailable"]) {
  test(`opens an app link whatever the session's organization is ${activeOrganizationId}`, async ({
    browser,
  }) => {
    const { person, alpha, context } = await organizationSession(browser);

    try {
      await environment.database.db
        .update(session)
        .set({ activeOrganizationId })
        .where(eq(session.userId, person.id));

      const appId = crypto.randomUUID();
      await environment.database.db.insert(apps).values({
        id: appId,
        organizationId: alpha,
        ownerId: person.id,
        slug: "linked-app",
        displayName: "Linked app",
        hostname: `linked-app-${alpha}.apps.localhost`,
      });
      const destination = `/${alpha}/apps/${appId}?q=linked%20app&view=overview`;
      const page = await context.newPage();
      await page.goto(destination);
      await expect(page).toHaveURL(`${environment.configuration.PLATFORM_URL}${destination}`);
      await expect(page.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Linked app", exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

test(`hides organizations a person cannot open`, async ({ browser }) => {
  const { person, beta, context } = await organizationSession(browser);

  try {
    await environment.database.db
      .delete(member)
      .where(and(eq(member.userId, person.id), eq(member.organizationId, beta)));
    const page = await context.newPage();

    for (const path of [`/${beta}`, `/${beta}/apps`, "/unknown-organization/apps"]) {
      expect((await page.goto(path))?.status(), path).toBe(404);
      await expect(page.getByRole("heading", { name: "Nothing here yet." })).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

test(`asks for the organization at the start page and opens the chosen one`, async ({
  browser,
}) => {
  const { beta, context } = await organizationSession(browser);

  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/organizations\?next=/);
    await page.getByRole("link", { name: /^Beta admin$/i }).click();
    await expect(page).toHaveURL(`${environment.configuration.PLATFORM_URL}/${beta}`);
    await expect(page.getByRole("link", { name: "Choose organization: Beta" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test(`rejects external destinations in the chooser`, async ({ browser }) => {
  const { alpha, context } = await organizationSession(browser);

  try {
    const page = await context.newPage();
    await page.goto("/organizations?next=%2F%2Fexternal.example.test");
    const link = page.getByRole("link", { name: /^Alpha admin$/i });
    await expect(link).toHaveAttribute("href", `/${alpha}`);
    await link.click();
    await expect(page).toHaveURL(`${environment.configuration.PLATFORM_URL}/${alpha}`);
    await expect(page.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("serves app icons from the workspace address of the app's organization", async ({
  browser,
}) => {
  const { person, alpha, beta, context } = await organizationSession(browser);
  const appId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();
  const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const hash = hashAsset("/favicon.svg", bytes);

  try {
    await environment.database.db.insert(apps).values({
      id: appId,
      organizationId: alpha,
      ownerId: person.id,
      slug: "icon-app",
      displayName: "Icon app",
      hostname: `icon-app-${alpha}.apps.localhost`,
    });
    await environment.database.db.insert(artifacts).values({
      id: artifactId,
      appId,
      manifest: { "/favicon.svg": { hash, size: bytes.length } },
      modules: [],
      metadata: workerMetadata.parse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        assets: { upload_session: artifactId },
      }),
    });
    await environment.database.db.insert(deployments).values({
      id: deploymentId,
      appId,
      artifactId,
      status: "succeeded",
      requestId: crypto.randomUUID(),
    });
    await environment.database.db
      .update(apps)
      .set({ state: "active", webEnabled: true, activeDeploymentId: deploymentId })
      .where(eq(apps.id, appId));
    await storage.send(
      new PutObjectCommand({
        Bucket: environment.environment.S3_BUCKET,
        Key: `apps/${appId}/assets/${hash}`,
        Body: bytes,
      }),
    );
    const icon = `/apps/${appId}/icon?deployment=${deploymentId}`;

    const response = await context.request.get(`/${alpha}${icon}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/svg+xml");
    expect(response.headers()["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await response.body())).toEqual(bytes);

    // Another organization's address does not reveal the app, and invalid IDs are missing too.
    for (const path of [`/${beta}${icon}`, "/unknown-organization" + icon, `/${alpha}/apps/x/icon`])
      expect((await context.request.get(path)).status(), path).toBe(404);

    // Without a session, existing and missing apps both lead to sign-in.
    const anonymous = await browser.newContext({
      baseURL: environment.configuration.PLATFORM_URL,
    });

    try {
      for (const id of [appId, crypto.randomUUID()]) {
        const signIn = await anonymous.request.get(`/${alpha}/apps/${id}/icon`, {
          maxRedirects: 0,
        });

        expect(signIn.status()).toBe(303);
        expect(new URL(signIn.headers()["location"] ?? "", "http://localhost").pathname).toBe(
          "/sign-in",
        );
      }
    } finally {
      await anonymous.close();
    }
  } finally {
    await environment.database.db.delete(apps).where(eq(apps.id, appId));
    await context.close();
  }
});

test("switches organizations from the sidebar menu", async ({ browser }) => {
  const { alpha, beta, context } = await organizationSession(browser);

  try {
    const page = await context.newPage();
    await page.goto(`/${alpha}`);
    // Before hydration the trigger is a plain link to the chooser.
    await page.waitForLoadState("networkidle");
    await page.getByRole("link", { name: "Choose organization: Alpha" }).click();
    // The switch navigates within the page instead of loading a new document.
    await page.evaluate(() => Object.assign(window, { organizationSwitchMarker: true }));
    await page.getByRole("menuitem", { name: /Beta/ }).click();
    await expect(page).toHaveURL(`${environment.configuration.PLATFORM_URL}/${beta}`);
    await expect(page.getByRole("link", { name: "Choose organization: Beta" })).toBeVisible();
    expect(await page.evaluate(() => "organizationSwitchMarker" in window)).toBe(true);

    // Plain digits pick an organization while the menu is open.
    await page.waitForLoadState("networkidle");
    await page.getByRole("link", { name: "Choose organization: Beta" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("1");
    await expect(page).toHaveURL(`${environment.configuration.PLATFORM_URL}/${alpha}`);
    await expect(page.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("keeps an open tab on its organization after another tab switches", async ({ browser }) => {
  const { person, alpha, beta, context } = await organizationSession(browser);

  try {
    const id = crypto.randomUUID();
    await environment.database.db.insert(apps).values({
      id,
      organizationId: alpha,
      ownerId: person.id,
      slug: "unfinished",
      displayName: "Unfinished",
      hostname: `unfinished-${alpha}.apps.localhost`,
    });
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto(`/${alpha}/apps/${id}`);
    await expect(first.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
    await first.waitForLoadState("networkidle");
    await first.getByRole("button", { name: "Edit name" }).click();
    const name = first.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Unfinished Alpha app");

    await second.goto(`/${beta}`);
    await expect(second.getByRole("link", { name: "Choose organization: Beta" })).toBeVisible();

    // Returning to a tab fires visibilitychange. Headless pages stay visible, so dispatch it.
    const recheck = first.waitForRequest((request) => request.url().includes("/getWorkspace"));
    await first.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const workspaceQuery = (await recheck).url();
    await expect(first.getByRole("link", { name: "Choose organization: Alpha" })).toBeVisible();
    await expect(name).toHaveValue("Unfinished Alpha app");
    await expect(
      first.locator("form", { has: name }).locator('input[name^="organizationId/"]'),
    ).toHaveValue(alpha);

    // The same recheck after the session ended sends the tab to sign-in.
    const anonymous = await browser.newContext();

    try {
      const response = await anonymous.request.get(workspaceQuery);
      const { data } = z.object({ data: z.string() }).parse(await response.json());
      expect(JSON.parse(data)).toEqual([{ redirect: 1 }, "/sign-in"]);
    } finally {
      await anonymous.close();
    }
  } finally {
    await context.close();
  }
});
