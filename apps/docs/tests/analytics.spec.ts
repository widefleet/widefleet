import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

interface CapturedEvent {
  event: string;
  properties: {
    $cookieless_mode?: boolean;
    $pathname?: string;
    distinct_id: string;
    query?: string;
  };
}

declare global {
  interface Window {
    posthog?: {
      __loaded: boolean;
      capture: (
        event: string,
        properties: Record<string, string>,
        options: { send_instantly: boolean },
      ) => CapturedEvent | undefined;
      config: {
        autocapture: boolean;
        cross_subdomain_cookie: boolean;
        disable_persistence: boolean;
        token: string;
      };
      get_distinct_id: () => string;
    };
  }
}

let sdk = "";

let events: CapturedEvent[] = [];

let sdkLoads = 0;

let analyticsRequests = 0;

test.beforeAll(async () => {
  const fixture = process.env["DOCS_POSTHOG_SDK_FIXTURE"];

  if (fixture) {
    sdk = await readFile(fixture, "utf8");
  } else {
    // Download public SDK code only; browser requests never reach PostHog.
    const response = await fetch("https://eu-assets.i.posthog.com/static/array.js");
    expect(response.ok).toBe(true);
    sdk = await response.text();
  }
});

test.beforeEach(async ({ context }) => {
  events = [];
  sdkLoads = 0;
  analyticsRequests = 0;
  await context.addInitScript(() => {
    // Represent a reader: PostHog otherwise drops automated-browser events.
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());

    if (url.hostname === "127.0.0.1" && url.port === (process.env["DOCS_TEST_PORT"] ?? "14321")) {
      await route.continue();

      return;
    }

    analyticsRequests += 1;

    if (url.pathname === "/static/array.js") {
      sdkLoads += 1;
      await route.fulfill({ contentType: "application/javascript", body: sdk });

      return;
    }

    if (url.pathname === "/e/" || url.pathname === "/i/v0/e/") {
      const body = route.request().postDataBuffer();

      if (!body) throw new Error("Expected an analytics request body");
      const decoded = body[0] === 31 && body[1] === 139 ? gunzipSync(body) : body;
      // SAFETY: The real SDK's capture endpoint emits a JSON batch with these
      // fields; the tests below assert the event names and properties received.
      const payload = JSON.parse(decoded.toString()) as { batch: CapturedEvent[] };
      events.push(...payload.batch);
    }

    await route.fulfill({
      contentType: url.pathname.endsWith(".js") ? "application/javascript" : "application/json",
      body: url.pathname.endsWith(".js")
        ? "({})"
        : JSON.stringify({
            featureFlags: {},
            featureFlagPayloads: {},
            supportedCompression: [],
            sessionRecording: false,
            autocapture_opt_out: false,
          }),
    });
  });
});

test("loads no analytics before a choice, including client navigation", async ({ page }) => {
  await page.goto("/docs");
  await expect(page.locator("[data-blume-consent-banner]")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(events).toEqual([]);
  expect(sdkLoads).toBe(0);
  expect(analyticsRequests).toBe(0);
  expect(await page.evaluate(() => document.cookie)).toBe("");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => window.posthog)).toBeUndefined();
  await page.locator('a[href="/docs/getting-started/quickstart"]').first().click();
  await expect(page).toHaveURL(/\/getting-started\/quickstart$/);
  await page.waitForLoadState("networkidle");
  expect(analyticsRequests).toBe(0);
});

test("loads no analytics for declining readers after a reload", async ({ page }) => {
  await page.goto("/docs");
  await page.locator('[data-blume-consent-choice="decline"]').click();
  expect(await page.evaluate(() => localStorage.getItem("blume-consent"))).toBe("denied");
  expect(await page.evaluate(() => document.cookie)).toContain("widefleet-consent=denied");
  await page.reload();
  await expect(page.locator("[data-blume-consent-banner]")).toBeHidden();
  await page.waitForLoadState("networkidle");
  expect(events).toEqual([]);
  expect(sdkLoads).toBe(0);
  expect(analyticsRequests).toBe(0);
  expect(await page.evaluate(() => document.cookie)).not.toContain("ph_phc_");
});

test("enables visits and interactions only after accepting and remembers consent", async ({
  page,
}) => {
  await page.goto("/docs");
  await page.locator('[data-blume-consent-choice="accept"]').click();
  await expect.poll(() => events.filter((event) => event.event === "$pageview").length).toBe(1);
  expect(await page.evaluate(() => document.cookie)).toContain("ph_phc_docs_synthetic");
  expect(await page.evaluate(() => window.posthog?.config.token)).toBe(
    "phc_docs_synthetic_verification",
  );
  expect(await page.evaluate(() => window.posthog?.config.autocapture)).toBe(true);
  expect(await page.evaluate(() => window.posthog?.config.cross_subdomain_cookie)).toBe(false);
  await page.evaluate(() =>
    window.posthog?.capture("search", { query: "synthetic_accepted" }, { send_instantly: true }),
  );
  await expect.poll(() => events.some((event) => event.event === "search")).toBe(true);
  const search = events.find((event) => event.event === "search");
  expect(search?.properties.query).toBe("synthetic_accepted");
  expect(search?.properties.distinct_id).not.toBe("$posthog_cookieless");
  expect(search?.properties.$cookieless_mode).not.toBe(true);
  await page.evaluate(() =>
    window.posthog?.capture("code_copy", { language: "typescript" }, { send_instantly: true }),
  );
  await expect.poll(() => events.some((event) => event.event === "code_copy")).toBe(true);
  const distinctId = await page.evaluate(() => window.posthog?.get_distinct_id());
  await page.reload();
  await expect.poll(() => events.filter((event) => event.event === "$pageview").length).toBe(2);
  expect(await page.evaluate(() => window.posthog?.get_distinct_id())).toBe(distinctId);
  await expect(page.locator("[data-blume-consent-banner]")).toBeHidden();
  await page.locator('a[href="/docs/getting-started/quickstart"]').first().click();
  await expect.poll(() => events.filter((event) => event.event === "$pageview").length).toBe(3);
  expect(sdkLoads).toBe(2);
});

test("withdrawal clears analytics storage and prevents all further requests until reaccepted", async ({
  page,
}) => {
  await page.goto("/docs");
  await page.locator('[data-blume-consent-choice="accept"]').click();
  await expect.poll(() => events.filter((event) => event.event === "$pageview").length).toBe(1);
  await page.locator("[data-blume-consent-open]").click();
  await Promise.all([
    page.waitForEvent("load"),
    page.locator('[data-blume-consent-choice="decline"]').click(),
  ]);
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.cookie)).toContain("widefleet-consent=denied");
  expect(await page.evaluate(() => document.cookie)).not.toContain("ph_phc_");
  expect(await page.evaluate(() => window.posthog)).toBeUndefined();
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ph_"))),
  ).toEqual([]);
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("ph_"))),
  ).toEqual([]);
  const requestCount = analyticsRequests;
  const eventCount = events.length;
  await page.locator('a[href="/docs/getting-started/quickstart"]').first().click();
  await page.waitForLoadState("networkidle");
  expect(analyticsRequests).toBe(requestCount);
  expect(events).toHaveLength(eventCount);
  expect(sdkLoads).toBe(1);
  await page.locator("[data-blume-consent-open]").click();
  await page.locator('[data-blume-consent-choice="accept"]').click();
  await expect.poll(() => events.filter((event) => event.event === "$pageview").length).toBe(2);
  expect(sdkLoads).toBe(2);
});

test("a local storage grant without a preference cookie does not start analytics", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("blume-consent", "granted"));
  await page.goto("/docs");
  await expect(page.locator("[data-blume-consent-banner]")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(analyticsRequests).toBe(0);
  expect(sdkLoads).toBe(0);
});
