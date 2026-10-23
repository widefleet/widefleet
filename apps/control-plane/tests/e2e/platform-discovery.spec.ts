import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../environment.ts";

const cloud = "https://app.widefleet.com";

const local = "http://127.0.0.1:25431";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let server: ReturnType<typeof spawn>;

let directory: string;

let logs = "";

const authRequests: string[] = [];

test.beforeAll(async () => {
  environment = await createTestEnvironment(cloud);
  directory = await mkdtemp(join(tmpdir(), "widefleet-browser-discovery-"));
  const records = join(directory, "dns.json");
  await writeFile(
    records,
    JSON.stringify({
      "_widefleet.company.test.": "url=https://platform.example.test",
      "_widefleet.cloud.test.": `url=${cloud}`,
      "_widefleet.broken.test.": "url=http://localhost",
    }),
  );
  server = spawn(
    process.execPath,
    ["--import", fileURLToPath(new URL("./dns.fixture.ts", import.meta.url)), "build"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        ...environment.environment,
        WIDEFLEET_TEST_DNS_FILE: records,
        WIDEFLEET_TELEMETRY_DISABLED: "1",
        LOGIN_CODE_DELIVERY: "console",
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "25431",
        PROTOCOL_HEADER: "x-forwarded-proto",
        HOST_HEADER: "x-forwarded-host",
        SHUTDOWN_TIMEOUT: "1",
      },
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
          return (
            await fetch(`${local}/healthz`, {
              headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.widefleet.com" },
            })
          ).ok;
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
    server.kill("SIGTERM");
    await exited;
    clearTimeout(timeout);
  }

  await environment?.close();

  if (directory) await rm(directory, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  authRequests.length = 0;
  // Both apparent public origins are fulfilled locally; the browser never calls production.
  await page.route(`${cloud}/**`, async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname.startsWith("/api/auth/")) authRequests.push(url.pathname);

    const response = await route.fetch({
      url: `${local}${url.pathname}${url.search}`,
      maxRedirects: 0,
      headers: {
        ...route.request().headers(),
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.widefleet.com",
      },
    });

    await route.fulfill({ response });
  });
  await page.route("https://platform.example.test/**", (route) =>
    route.fulfill({ body: "Company sign-in" }),
  );
});

test("routes an email to its company before requesting a Cloud sign-in code", async ({ page }) => {
  await page.goto(`${cloud}/sign-in?next=/settings`);
  await page.getByLabel("Email", { exact: true }).fill("employee@company.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(
    "https://platform.example.test/sign-in?email=employee%40company.test",
  );
  expect(authRequests).toEqual([]);
});

test("keeps users without a published company mapping in Cloud", async ({ page }) => {
  await page.goto(`${cloud}/sign-in`);
  await page.getByLabel("Email", { exact: true }).fill("employee@unpublished.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Sign-in code", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${cloud}/sign-in`);
  expect(authRequests).toContain("/api/auth/email-otp/send-verification-otp");
});

test("stops on invalid discovery without creating a Cloud login", async ({ page }) => {
  await page.goto(`${cloud}/sign-in`);
  await page.getByLabel("Email", { exact: true }).fill("employee@broken.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByText("Could not determine your company's platform.", { exact: false }),
  ).toBeVisible();
  expect(authRequests).toEqual([]);
});

test("preserves explicit organization sign-in for guests", async ({ page }) => {
  await page.goto(`${cloud}/sign-in?organization=widefleet`);
  await page.getByLabel("Email", { exact: true }).fill("guest@company.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Sign-in code", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${cloud}/sign-in?organization=widefleet`);
});

test("does not carry an existing Cloud device grant to another installation", async ({ page }) => {
  await page.goto(`${cloud}/sign-in?next=${encodeURIComponent("/device?user_code=SECRET")}`);
  await page.getByLabel("Email", { exact: true }).fill("employee@company.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Sign-in code", { exact: true })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(cloud);
  expect(authRequests).toContain("/api/auth/email-otp/send-verification-otp");
});

test("exposes Cloud defaults and explicit configuration errors through the discovery API", async ({
  request,
}) => {
  const headers = { "x-forwarded-proto": "https", "x-forwarded-host": "app.widefleet.com" };

  const found = await request.get(`${local}/api/platform-discovery?domain=company.test`, {
    headers,
  });

  expect(await found.json()).toEqual({ platform_url: "https://platform.example.test" });
  expect(found.headers()["cache-control"]).toBe("private, no-store");

  const absent = await request.get(`${local}/api/platform-discovery?domain=unpublished.test`, {
    headers,
  });

  expect(absent.status()).toBe(200);
  expect(await absent.json()).toEqual({ platform_url: cloud });
  expect(
    (await request.get(`${local}/api/platform-discovery?domain=broken.test`, { headers })).status(),
  ).toBe(503);
  expect(
    (
      await request.get(`${local}/api/platform-discovery?domain=https://company.test`, { headers })
    ).status(),
  ).toBe(400);
});
