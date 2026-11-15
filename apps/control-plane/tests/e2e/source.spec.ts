import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as contract from "@platform/contracts";
import { eq } from "drizzle-orm";
import { apps, artifacts, deployments } from "../../src/lib/server/schema.ts";
import { createTestEnvironment } from "../environment.ts";

test.skip(process.env["RUN_SOURCE_TESTS"] !== "1", "Build with the source-extension fixture first");

test.use({ baseURL: "http://localhost:28430" });

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let server: ReturnType<typeof spawn>;

let directory: string;

let state: string;

const start = async (enabled: boolean) => {
  let logs = "";
  server = spawn(process.execPath, ["build"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...process.env,
      ...environment.environment,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "28430",
      PROTOCOL_HEADER: "x-forwarded-proto",
      SHUTDOWN_TIMEOUT: "1",
      WIDEFLEET_TEST_SOURCE_ENABLED: enabled ? "1" : "0",
      WIDEFLEET_TEST_SOURCE_STATE: state,
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

        return fetch("http://localhost:28430/healthz")
          .then((response) => response.ok)
          .catch(() => false);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
};

const stop = async () => {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
};

test.beforeAll(async () => {
  environment = await createTestEnvironment("http://localhost:28430");
  directory = await mkdtemp(join(tmpdir(), "widefleet-source-ui-"));
  state = join(directory, "source.json");
  await writeFile(state, "{}");
  await start(false);
});

test.afterAll(async () => {
  await stop();
  await environment.close();
  await rm(directory, { recursive: true, force: true });
});

test("source guidance, saved and deployed commits, deletion wording and denied access", async ({
  page,
  context,
  browser,
}, testInfo) => {
  const login = await environment.users.login({ userId: environment.owner.id });

  const cookies = login.cookies.map((cookie) => ({
    ...cookie,
    domain: "localhost",
    sameSite: "Lax" as const,
    secure: false,
  }));

  await context.addCookies(cookies);

  const response = await context.request.post("/api/v1/apps", {
    headers: { origin: environment.configuration.PLATFORM_URL },
    data: { slug: "inventory", displayName: "Inventory and warehouse operations" },
  });

  expect(response.ok()).toBe(true);
  const app = contract.app.parse(await response.json());

  await page.goto(`/apps/${app.id}`);
  await expect(page.getByRole("link", { name: "Source", exact: true })).toHaveCount(0);

  for (const [name, width, height, theme] of [
    ["desktop-light", 1440, 1000, "light"],
    ["mobile-dark", 390, 844, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({ path: testInfo.outputPath(`before-${name}.png`), fullPage: true });
  }

  await stop();
  await start(true);
  await page.goto(`/apps/${app.id}/source`);
  await expect(page.getByText("No source has been saved yet.", { exact: false })).toBeVisible();

  for (const [name, width, height, theme] of [
    ["desktop-light", 1440, 1000, "light"],
    ["mobile-dark", 390, 844, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({ path: testInfo.outputPath(`empty-${name}.png`), fullPage: true });
  }

  await expect(
    page.getByRole("button", { name: "Create Git repository", exact: true }),
  ).toHaveCount(0);

  const setup = await context.request.post(`/api/v1/apps/${app.id}/source/prepare`, {
    headers: { origin: environment.configuration.PLATFORM_URL },
    data: {},
  });

  expect(setup.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Git URL", exact: true })).toBeVisible();
  await expect(page.getByText("No commits", { exact: true })).toBeVisible();
  await expect(page.getByText("Change source branch", { exact: true })).toHaveCount(0);

  const deployed = { branch: "main", commit: "a".repeat(40), directory: "apps/inventory" };
  const artifactId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();

  const metadata = contract.workerMetadata.parse({
    main_module: "worker.js",
    compatibility_date: "2026-10-01",
    assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
    source: deployed,
  });

  await environment.database.db
    .insert(artifacts)
    .values({ id: artifactId, appId: app.id, metadata, modules: [], manifest: {} });
  await environment.database.db.insert(deployments).values({
    id: deploymentId,
    appId: app.id,
    artifactId,
    status: "succeeded",
    requestId: crypto.randomUUID(),
  });
  await environment.database.db
    .update(apps)
    .set({ activeDeploymentId: deploymentId, state: "active" })
    .where(eq(apps.id, app.id));
  await writeFile(state, JSON.stringify({ [app.id]: { main: "b".repeat(40) } }));
  await page.reload();
  await expect(page.getByText(deployed.commit, { exact: true })).toBeVisible();
  await expect(page.getByText("b".repeat(40), { exact: true })).toBeVisible();
  await expect(page.getByText(deployed.directory, { exact: true })).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy clone command" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Copy clone command" }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy clone command" })).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    for (const [name, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({
        path: testInfo.outputPath(`after-${name}-${theme}.png`),
        fullPage: true,
      });
    }
  }

  await page.goto(`/apps/${app.id}/settings`);
  await expect(
    page.getByText(
      "Any associated Widefleet Git repository and its branches will also be permanently deleted.",
    ),
  ).toBeVisible();
  await page.getByText("Permanently delete app", { exact: true }).click();
  await expect(page.getByRole("checkbox")).toHaveAccessibleName(
    /including its Widefleet Git repository/,
  );

  const savedState = await readFile(state, "utf8");
  await writeFile(state, "invalid fixture state");
  await page.goto(`/apps/${app.id}/source`);
  await expect(page.getByRole("alert")).toContainText("The source repository is unavailable");
  await expect(page.getByRole("button", { name: "Create Git repository" })).toHaveCount(0);

  for (const theme of ["light", "dark"] as const) {
    for (const [name, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({
        path: testInfo.outputPath(`outage-${name}-${theme}.png`),
        fullPage: true,
      });
    }
  }

  await page.getByRole("link", { name: "App settings", exact: true }).click();
  await expect(
    page.getByText(
      "Any associated Widefleet Git repository and its branches will also be permanently deleted.",
    ),
  ).toBeVisible();
  const sourceReads = await readFile(`${state}.reads`, "utf8");
  await page.getByRole("link", { name: /^Deployments/ }).click();
  await expect(page.getByTitle("Deployment ID", { exact: true })).toHaveText(deploymentId);
  await page.getByRole("button", { name: "Refresh app" }).click();
  await expect(page.getByRole("button", { name: "Refresh app" })).toBeEnabled();
  expect(await readFile(`${state}.reads`, "utf8")).toBe(sourceReads);
  await writeFile(state, savedState);
  await page.goto(`/apps/${app.id}/source`);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(deployed.commit, { exact: true })).toBeVisible();

  const noScript = await browser.newContext({
    javaScriptEnabled: false,
    baseURL: "http://localhost:28430",
    extraHTTPHeaders: { "x-forwarded-proto": "http" },
  });

  await noScript.addCookies(cookies);
  const plain = await noScript.newPage();
  await plain.goto(`/apps/${app.id}/source`);
  await expect(plain.getByText("main", { exact: true })).toBeVisible();
  await expect(plain.getByText(deployed.commit, { exact: true })).toBeVisible();
  await expect(plain.getByText("Change source branch", { exact: true })).toHaveCount(0);
  await noScript.close();

  const previewResponse = await context.request.post("/api/v1/apps", {
    headers: { origin: environment.configuration.PLATFORM_URL },
    data: {
      slug: "inventory-review",
      displayName: "Inventory review",
      parentId: app.id,
      previewBranch: "review",
    },
  });

  expect(previewResponse.ok()).toBe(true);
  const preview = contract.app.parse(await previewResponse.json());
  await page.goto(`/apps/${preview.id}/source`);
  await expect(page.getByText("review", { exact: true })).toBeVisible();
  await expect(
    page.getByText("This preview uses a branch in the main app’s repository."),
  ).toBeVisible();
  await expect(page.getByText("Change source branch", { exact: true })).toHaveCount(0);

  const manualResponse = await context.request.post("/api/v1/apps", {
    headers: { origin: environment.configuration.PLATFORM_URL },
    data: {
      slug: "inventory-manual",
      displayName: "Manual preview",
      parentId: app.id,
      previewName: "manual",
    },
  });

  expect(manualResponse.ok()).toBe(true);
  const manual = contract.app.parse(await manualResponse.json());
  await page.goto(`/apps/${manual.id}/source`);
  await expect(page.getByRole("button", { name: "Copy preview command" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Git URL" })).toHaveCount(0);

  // Unauthenticated requests never expose the repository URL or source metadata.
  const anonymous = await browser.newContext({
    baseURL: "http://localhost:28430",
    extraHTTPHeaders: { "x-forwarded-proto": "http" },
  });

  expect((await anonymous.request.get(`/api/v1/apps/${app.id}/source`)).status()).toBe(401);
  await anonymous.close();
});
