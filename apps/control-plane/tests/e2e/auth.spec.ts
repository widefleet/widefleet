import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { expect, test, type APIResponse } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  app,
  artifact,
  serviceDocumentation,
  workerMetadata,
  type userConnectionInvocation,
} from "@platform/contracts";
import {
  account,
  member,
  user,
  ssoProvider,
  session as authSession,
} from "../../src/lib/server/auth-schema.ts";
import {
  agents,
  apps,
  artifacts,
  deployments,
  jobs,
  organizationSettings,
} from "../../src/lib/server/schema.ts";
import { apiResource, cliClientId } from "../../src/lib/server/auth-options.ts";
import {
  encodeDocumentation,
  storeDocumentation,
} from "../../src/lib/server/artifact-documentation.ts";
import { createStorage } from "../../src/lib/server/storage.ts";
import { createTestEnvironment } from "../environment.ts";
import { authConfiguration, createAuthProxy } from "@platform/auth-proxy";
import { registerAppLogin, readAppLogin } from "../../src/lib/server/app-login-client.ts";
import { prepareOrganizationInvitation } from "../../src/lib/server/members.ts";
import { installationOrganizationId } from "../../src/lib/organization.ts";
import { storedAppSecrets } from "../../src/lib/server/app-secrets.ts";
import { parseJsonc } from "@platform/contracts/jsonc";
import { bundleResult } from "@platform/contracts/builds";

// A remote function's redirect arrives as a result whose serialized data names the location.
// A query names its page's organization. SvelteKit sends a query argument as URL-safe Base64 of
// its devalue encoding.
const organizationQuery = (path: string, organizationId = installationOrganizationId) =>
  `${path}?payload=${Buffer.from(JSON.stringify([{ organizationId: 1 }, organizationId])).toString("base64url")}`;

const remoteRedirect = async (response: APIResponse) => {
  const { data } = z
    .object({ type: z.literal("result"), data: z.string() })
    .parse(await response.json());

  const values = z.array(z.unknown()).parse(JSON.parse(data));
  const { redirect } = z.object({ redirect: z.number() }).parse(values[0]);

  return z.string().parse(values[redirect]);
};

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

let s3: S3Client | undefined;

let server: ReturnType<typeof spawn>;

let logs = "";

// While this file exists, the server's template source answers the list with an error.
const templateOutage = join(tmpdir(), `widefleet-template-outage-${process.pid}`);

// A synthetic app builder for one-click installs. It builds every template as
// one fixed Worker that requires the secrets the template's Wrangler file lists.
const builder = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8").on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    response.setHeader("content-type", "application/json");

    if (request.url === "/document") {
      response.end(
        JSON.stringify({ documentation: { format: 3, entrypoints: [], types: [] }, warnings: [] }),
      );

      return;
    }

    const { files } = z.object({ files: z.record(z.string(), z.string()) }).parse(JSON.parse(body));

    const wrangler = z
      .object({ secrets: z.object({ required: z.array(z.string()) }).optional() })
      .parse(parseJsonc(files["wrangler.jsonc"] ?? "{}"));

    const map = `map-${"e".repeat(64)}.map`;

    response.end(
      JSON.stringify(
        bundleResult.parse({
          worker: 'export default { fetch: () => new Response("Hello") };\n',
          map: JSON.stringify({ version: 3, sources: ["src/app.ts"], names: [], mappings: "" }),
          entry: "src/app.ts",
          metadata: {
            main_module: "worker.js",
            compatibility_date: "2026-10-01",
            compatibility_flags: [],
            bindings: [],
            debug: { build_id: crypto.randomUUID(), source_maps: { "worker.js": map } },
            web: true,
            entrypoints: [],
            crons: [],
            queue_consumers: [],
            required_secrets: wrangler.secrets?.required,
          },
          warnings: [],
        }),
      ),
    );
  });
});

// Model the trusted reverse proxy for browser and OAuth back-channel requests.
const edge = createServer((request, response) => {
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: 25431,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, "x-forwarded-proto": "http" },
    },
    (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    },
  );

  upstream.on("error", () => response.writeHead(502).end());
  request.pipe(upstream);
});

test.beforeAll(async () => {
  environment = await createTestEnvironment();
  // The server keeps API documentation in artifact storage.
  const bucket = `test-${crypto.randomUUID()}`;
  environment.environment.S3_BUCKET = bucket;
  environment.configuration.S3_BUCKET = bucket;
  s3 = new S3Client({
    endpoint: environment.configuration.S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: environment.environment.S3_ACCESS_KEY_ID,
      secretAccessKey: environment.environment.S3_SECRET_ACCESS_KEY,
    },
  });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  edge.listen(25430);
  await once(edge, "listening");
  builder.listen(25437, "127.0.0.1");
  await once(builder, "listening");
  server = spawn(
    process.execPath,
    ["--import", fileURLToPath(new URL("./templates.fixture.ts", import.meta.url)), "build"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        ...environment.environment,
        LOGIN_CODE_DELIVERY: "console",
        TEMPLATE_OUTAGE: templateOutage,
        PLATFORM_APP_BUILDER_URL: "http://127.0.0.1:25437/",
        GOOGLE_CLIENT_ID: "synthetic-google-client",
        GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
        MICROSOFT_CLIENT_ID: "synthetic-microsoft-client",
        MICROSOFT_CLIENT_SECRET: "synthetic-microsoft-secret",
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "25431",
        PROTOCOL_HEADER: "x-forwarded-proto",
        SHUTDOWN_TIMEOUT: "1",
        BODY_SIZE_LIMIT: "32M",
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
          return (await fetch(`${environment.configuration.PLATFORM_URL}/healthz`)).ok;
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
});

test(`connects open APIs and requests restricted APIs`, async ({ browser }, testInfo) => {
  const creator = environment.users.createUser({
    name: "Connection creator",
    email: `connections@example.test`,
  });

  await environment.users.saveUser(creator);
  await environment.linkMicrosoftUser(creator.id);

  const contexts = await Promise.all(
    [creator.id, environment.ownerId].map(async (userId) => {
      const context = await browser.newContext({
        baseURL: environment.configuration.PLATFORM_URL,
        extraHTTPHeaders: { "x-forwarded-proto": "http" },
      });

      const login = await environment.users.login({ userId });
      await context.addCookies(
        login.cookies.map((cookie) => ({
          ...cookie,
          domain: "localhost",
          sameSite: "Lax" as const,
          secure: false,
        })),
      );

      return context;
    }),
  );

  const [memberContext, adminContext] = contexts;

  if (!memberContext || !adminContext) throw new Error("Missing test context");
  const createdAppIds: string[] = [];

  try {
    const page = await memberContext.newPage();
    const adminPage = await adminContext.newPage();

    const create = async (context: typeof memberContext, slug: string, displayName: string) => {
      const response = await context.request.post("/api/v1/apps", {
        headers: { origin: environment.configuration.PLATFORM_URL },
        data: { slug, displayName },
      });

      expect(response.ok()).toBe(true);

      const created = app.parse(await response.json());
      createdAppIds.push(created.id);

      return created;
    };

    const source = await create(
      memberContext,
      `requester`,
      `Warehouse application with a longer name`,
    );

    const target = {
      // A colliding UUID must also satisfy the slug's leading-letter requirement.
      id: `a${crypto.randomUUID().slice(1)}`,
      slug: `request-api`,
      displayName: `Inventory and fulfillment service`,
    };

    await environment.database.db.insert(apps).values({
      ...target,
      organizationId: "widefleet",
      ownerId: environment.ownerId,
      hostname: `${target.slug}.${environment.configuration.APP_DOMAIN}`,
    });
    createdAppIds.push(target.id);

    const collision = await create(adminContext, target.id, "UUID-shaped slug API");
    const deploymentId = crypto.randomUUID();

    for (const provider of [target, collision]) {
      const artifactId = crypto.randomUUID();
      const id = provider.id === target.id ? deploymentId : crypto.randomUUID();
      await environment.database.db.insert(artifacts).values({
        id: artifactId,
        appId: provider.id,
        manifest: {},
        modules: [],
        metadata: workerMetadata.parse({
          main_module: "worker.js",
          compatibility_date: "2026-10-01",
          entrypoints: ["Reader"],
          assets: { upload_session: artifactId },
        }),
      });
      await environment.database.db.insert(deployments).values({
        id,
        appId: provider.id,
        artifactId,
        status: "succeeded",
        requestId: crypto.randomUUID(),
      });
      await environment.database.db
        .update(apps)
        .set({ activeDeploymentId: id })
        .where(eq(apps.id, provider.id));
    }

    for (const service of [target.id, target.slug]) {
      await adminPage.goto(`/widefleet/services/${service}/availability`);
      await expect(
        adminPage.getByText(`Choose who can connect ${target.displayName} to their apps.`, {
          exact: true,
        }),
      ).toBeVisible();
      await page.goto(`/widefleet/services/${service}/connect`);
      await expect(
        page.getByRole("heading", { name: `Connect ${target.displayName}`, exact: true }),
      ).toBeVisible();
    }

    await page.goto("/widefleet/services/requests");
    await expect(page.getByText("No connection requests yet.")).toBeVisible();
    await page.goto("/widefleet/services");
    await expect(page.getByText("Manage availability", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Binding name in your code")).toHaveCount(0);
    await page.getByRole("link", { name: `Connect to ${target.displayName}` }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Binding name in your code")).toHaveCount(0);
    await page.getByLabel("Your app", { exact: true }).selectOption(source.id);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/widefleet/services/${target.id}/connect\\?app=${source.id}`),
    );
    await expect(
      page.getByRole("heading", { name: "Request a connection", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to app selection" }).click();
    await expect(page.getByLabel("Your app", { exact: true })).toBeVisible();
    await page.getByLabel("Your app", { exact: true }).selectOption(source.id);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Binding name in your code").fill("ERP");
    await page.getByRole("button", { name: "Submit request" }).click();
    await expect(page.getByRole("heading", { name: "Request submitted" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve and connect" })).toHaveCount(0);
    const requests = await memberContext.request.get("/api/v1/connection-requests");

    const entries = z
      .array(z.object({ id: z.string(), status: z.string(), serviceId: z.string() }))
      .parse(await requests.json());

    expect(entries[0]?.serviceId).toBe(target.id);
    const id = entries[0]?.id;

    if (!id) throw new Error("Missing request");

    const denied = await memberContext.request.post(`/api/v1/connection-requests/${id}/approve`, {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: {},
    });

    expect(denied.status()).toBe(403);
    await adminPage.goto("/widefleet/services/requests");

    const review = adminPage
      .getByRole("listitem", {
        name: `${source.displayName} to ${target.displayName}`,
        exact: true,
      })
      .filter({ hasText: "Awaiting approval" });

    for (const width of [1280, 390]) {
      await adminPage.setViewportSize({ width, height: 900 });

      for (const colorScheme of ["light", "dark"] as const) {
        await adminPage.emulateMedia({ colorScheme });
        await adminPage.screenshot({
          path: testInfo.outputPath(`review-${width}-${colorScheme}.png`),
          fullPage: true,
        });
        expect(
          await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
    }

    await review.getByRole("button", { name: "Approve and connect" }).click();
    await expect(review).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Request approved" })).toBeVisible();
    await page.getByRole("link", { name: "View app connections" }).click();
    await expect(page.getByText("ERP", { exact: true })).toBeVisible();
    await environment.database.db
      .update(apps)
      .set({ capabilityError: "Synthetic activation failure" })
      .where(eq(apps.id, source.id));
    await page.goto(`/widefleet/apps/${source.id}/connections`);
    await page.locator("summary").filter({ hasText: "ERP" }).click();

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });

      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.screenshot({
          path: testInfo.outputPath(`retry-${width}-${colorScheme}.png`),
          fullPage: true,
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
    }

    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: null })
      .where(eq(apps.id, target.id));
    await page.getByRole("button", { name: "Retry connection ERP", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({
        hasText: "Deploy the target app's service entrypoint successfully before connecting it",
      }),
    ).toBeVisible();
    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: deploymentId })
      .where(eq(apps.id, target.id));
    await page.getByRole("button", { name: "Retry connection ERP", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/widefleet/apps/${source.id}/connections$`));
    await expect(page.getByText("ERP", { exact: true })).toBeVisible();
    await expect(page.getByText("Synthetic activation failure", { exact: false })).toHaveCount(0);
    await adminPage.goto(`/widefleet/services/${target.id}`);
    await adminPage.getByRole("link", { name: "Manage availability", exact: true }).click();
    await adminPage.getByLabel("Who can connect this API?").selectOption("organization");
    await adminPage.getByRole("button", { name: "Save availability" }).click();
    await expect(adminPage.getByText("Availability saved.", { exact: true })).toBeVisible();

    const availability = await environment.database.db
      .select({ id: apps.id, accessMode: apps.serviceAccessMode })
      .from(apps)
      .where(inArray(apps.id, [target.id, collision.id]));

    expect(availability).toEqual(
      expect.arrayContaining([
        { id: target.id, accessMode: "organization" },
        { id: collision.id, accessMode: "approval_required" },
      ]),
    );
    await page.goto(`/widefleet/services?app=${source.id}`);
    await page.getByRole("link", { name: `Connect to ${target.displayName}` }).click();
    await expect(page.getByLabel("Your app", { exact: true })).toHaveCount(0);
    await page.getByLabel("Binding name in your code").fill("FREE");

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });

      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.screenshot({
          path: testInfo.outputPath(`services-${width}-${colorScheme}.png`),
          fullPage: true,
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
    }

    await page.getByRole("button", { name: "Connect API", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Connection saved", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("env.FREE", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "View app connections" }).click();
    await expect(page).toHaveURL(new RegExp(`/widefleet/apps/${source.id}/connections$`));
    await expect(page.getByText("FREE", { exact: true })).toBeVisible();
    await adminPage.getByLabel("Who can connect this API?").selectOption("approval_required");
    await adminPage.getByRole("button", { name: "Save availability" }).click();
    await expect(adminPage.getByText("Availability saved.", { exact: true })).toBeVisible();
    await page.goto(`/widefleet/services/${target.id}/connect?app=${source.id}`);
    await page.getByLabel("Binding name in your code").fill("ERP");
    await page.getByRole("button", { name: "Submit request" }).click();
    await expect(page.getByRole("alert")).toContainText("Choose an unused binding name");
    await expect(page.getByLabel("Binding name in your code")).toHaveValue("ERP");
    await page.getByLabel("Binding name in your code").fill("REJECTED");
    await page.getByRole("button", { name: "Submit request" }).click();
    await expect(page.getByRole("heading", { name: "Request submitted" })).toBeVisible();
    await adminPage.goto("/widefleet/services/requests");
    await review.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(review).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Request rejected" })).toBeVisible();
    await page.goto(`/widefleet/apps/${source.id}/connections`);

    const freeConnection = page
      .locator("details")
      .filter({ has: page.locator("summary").filter({ hasText: "FREE" }) });

    await freeConnection.locator("summary").click();
    await freeConnection.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText("FREE", { exact: true })).toHaveCount(0);
    await expect(page.getByText("ERP", { exact: true })).toBeVisible();

    const forbiddenAvailability = await page.goto(`/widefleet/services/${target.id}/availability`);

    expect(forbiddenAvailability?.status()).toBe(403);

    const forbiddenApp = await page.goto(
      `/widefleet/services/${target.id}/connect?app=${target.id}`,
    );

    expect(forbiddenApp?.status()).toBe(404);
    await page.goto("/widefleet/services/requests");
    await page.screenshot({ path: testInfo.outputPath("request-statuses.png"), fullPage: true });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await environment.database.db.delete(apps).where(inArray(apps.id, createdAppIds));
    await environment.database.db.delete(user).where(eq(user.id, creator.id));
  }
});

test("shows versioned service documentation through authenticated API and accessible pages", async ({
  page,
  context,
}, testInfo) => {
  const session = await environment.users.login({ userId: environment.owner.id });

  const cookies = session.cookies.map((cookie) => ({
    ...cookie,
    domain: "localhost",
    sameSite: "Lax" as const,
    secure: false,
  }));

  await context.addCookies(cookies);

  const created = await context.request.post("/api/v1/apps", {
    headers: { origin: environment.configuration.PLATFORM_URL },
    data: { slug: "documented-service", displayName: "Inventory service" },
  });

  expect(created.ok()).toBe(true);
  const record = app.parse(await created.json());
  const storage = createStorage(environment.configuration);

  const documentation = serviceDocumentation.parse({
    format: 3,
    types: [
      {
        name: "InventoryItem",
        kind: "type",
        definition: "type InventoryItem = { id: string; displayName: string };",
        summary: "An inventory item.",
        remarks: "",
        deprecated: "Use CatalogItem when migrating callers.",
        examples: [
          '```ts\nconst item: InventoryItem = { id: "one", displayName: "Spare part" };\n```',
        ],
      },
    ],
    entrypoints: [
      {
        name: "Reader",
        summary: "Read inventory available to the signed-in user.",
        remarks: "",
        examples: [],
        http: false,
        methods: [
          {
            name: "findItems",
            summary: "Find matching items.",
            remarks: "Results are paginated. Continue with the returned cursor.",
            examples: ['```ts\nconst result = await env.INVENTORY.findItems("spare parts");\n```'],
            throws: [],
            signatures: [
              {
                parameters: [
                  {
                    name: "query",
                    type: "string",
                    description: "Words to search for.",
                    optional: false,
                    rest: false,
                  },
                ],
                returns: {
                  type: "Promise<Array<InventoryItem>>",
                  description: "Matching inventory items.",
                },
                uses: ["InventoryItem"],
              },
            ],
          },
        ],
      },
    ],
  });

  // Publishing keeps documentation in artifact storage and a summary on the artifact.
  const activate = async (document?: z.infer<typeof serviceDocumentation>) => {
    const artifactId = crypto.randomUUID();
    const deploymentId = crypto.randomUUID();
    const encoded = document ? encodeDocumentation(document) : null;

    if (encoded) (await storeDocumentation(storage, record.id, artifactId, encoded)).unwrap();
    await environment.database.db.insert(artifacts).values({
      id: artifactId,
      appId: record.id,
      metadata: workerMetadata.parse({
        main_module: "worker.js",
        compatibility_date: "2026-10-01",
        entrypoints: ["Reader"],
        assets: { upload_session: artifactId },
      }),
      manifest: {},
      modules: [],
      documentation: encoded?.summary ?? null,
    });
    await environment.database.db.insert(deployments).values({
      id: deploymentId,
      appId: record.id,
      artifactId,
      status: "succeeded",
      requestId: crypto.randomUUID(),
    });
    await environment.database.db
      .update(apps)
      .set({ activeDeploymentId: deploymentId })
      .where(eq(apps.id, record.id));

    return deploymentId;
  };

  const deploymentId = await activate(documentation);
  const description = await context.request.get(`/api/v1/app-services/${record.slug}`);
  expect(description.ok()).toBe(true);
  expect(await description.json()).toMatchObject({
    deploymentId,
    methods: [{ entrypoint: "Reader", name: "findItems", summary: "Find matching items." }],
    documentation: null,
  });

  const selected = await context.request.get(
    `/api/v1/app-services/${record.slug}?entrypoint=Reader&methods[]=findItems`,
  );

  expect(await selected.json()).toMatchObject({
    documentation: {
      entrypoint: { name: "Reader", methods: [{ name: "findItems" }] },
      types: [{ name: "InventoryItem" }],
    },
  });
  await page.goto("/widefleet/services");
  await page
    .getByRole("link", { name: "Inventory service API documentation", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Inventory service", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "findItems", exact: true })).toBeVisible();
  await expect(page.getByText("Words to search for.", { exact: false })).toBeVisible();
  await page.getByText("InventoryItem", { exact: true }).click();
  await expect(page.getByText("Deprecated: Use CatalogItem when migrating callers.")).toBeVisible();
  await expect(
    page.getByText('const item: InventoryItem = { id: "one", displayName: "Spare part" };'),
  ).toBeVisible();

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({
        path: testInfo.outputPath(`api-${width}-${colorScheme}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  }

  await page.getByRole("link", { name: "Back to app APIs" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/services$/);

  await activate({ format: 3, entrypoints: [], types: [] });
  await page.goto(`/widefleet/services/${record.id}`);
  await expect(
    page.getByText("No API documentation was generated.", { exact: false }),
  ).toBeVisible();
  await activate();
  await page.reload();
  await expect(
    page.getByText("This deployment has no API documentation.", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("api-legacy-mobile-dark.png"),
    fullPage: true,
  });
  const missing = await page.goto(`/widefleet/services/${crypto.randomUUID()}`);
  expect(missing?.status()).toBe(404);
});

test("completes app OAuth through the built server after signing in", async ({ page }) => {
  await environment.database.db.update(ssoProvider).set({ domainVerified: false });
  await environment.database.db
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, environment.owner.id));
  await environment.database.db.transaction((transaction) =>
    registerAppLogin(
      transaction,
      environment.configuration,
      environment.environment.PLATFORM_ENCRYPTION_KEY,
      "widefleet",
    ),
  );

  const identity = await readAppLogin(
    environment.database.db,
    environment.configuration,
    environment.environment.PLATFORM_ENCRYPTION_KEY,
    "widefleet",
  );

  if (!identity) throw new Error("App client was not registered");

  const configuration = authConfiguration.parse({
    organizationId: "widefleet",
    provider: identity.provider,
    ...identity.management,
    cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
    domain: "apps.localhost",
    redirectUrl: "https://auth.apps.localhost/oauth2/widefleet/callback",
  });

  const appUrl = "https://notes.apps.localhost/";

  const proxy = createAuthProxy(configuration, {
    resolve: async (hostname) =>
      hostname === "notes.apps.localhost" ? { revision: 0, groups: [] } : null,
    fetch: async () => new Response("Signed in to the app"),
  });

  const started = await proxy.fetch(
    new Request(
      `https://auth.apps.localhost/oauth2/widefleet/start?rd=${encodeURIComponent(appUrl)}`,
    ),
  );

  expect(started.status).toBe(302);
  await page.route(`${configuration.redirectUrl}*`, (route) =>
    route.fulfill({ body: "App callback" }),
  );
  await page.goto(z.url().parse(started.headers.get("location")));
  await expect(page).toHaveURL(/\/sign-in\?/);
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByRole("button", { name: "Continue with email", exact: true }).click();
  await expect.poll(() => logs.match(/code is (\d{6})/)?.[1]).toBeTruthy();
  await page
    .getByLabel("Sign-in code", { exact: true })
    .fill(z.string().parse(logs.match(/code is (\d{6})/)?.[1]));
  await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${configuration.redirectUrl}\\?`));

  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .filter((value) => !value.includes("Max-Age=0"))
      .map((value) => value.split(";")[0])
      .join("; ");

  const completed = await proxy.fetch(
    new Request(page.url(), { headers: { cookie: cookies(started) } }),
  );

  expect(completed.headers.get("location"), await completed.clone().text()).toBe(appUrl);

  const opened = await proxy.fetch(
    new Request(appUrl, { headers: { cookie: cookies(completed) } }),
  );

  expect(opened.status).toBe(200);
  expect(await opened.text()).toBe("Signed in to the app");
});

test.afterAll(async () => {
  edge.closeAllConnections();
  await new Promise<void>((resolve) => edge.close(() => resolve()));
  builder.closeAllConnections();
  await new Promise<void>((resolve) => builder.close(() => resolve()));

  if (server?.exitCode === null) {
    const exited = once(server, "exit");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
    server.kill("SIGTERM");
    await exited;
    clearTimeout(timeout);
  }

  if (s3) {
    const Bucket = environment.configuration.S3_BUCKET;
    const contents = await s3.send(new ListObjectsV2Command({ Bucket }));

    if (contents.Contents?.length)
      await s3.send(
        new DeleteObjectsCommand({
          Bucket,
          Delete: { Objects: contents.Contents.map(({ Key }) => ({ Key })) },
        }),
      );
    await s3.send(new DeleteBucketCommand({ Bucket }));
    s3.destroy();
  }

  await environment?.close();
});

test.afterEach(async ({ browserName }, info) => {
  await environment.database.db.update(ssoProvider).set({ domainVerified: false });

  if (info.status !== info.expectedStatus)
    await info.attach(`${browserName}-server-log`, { body: logs, contentType: "text/plain" });
});

// Each age needs a fresh session/context: background requests from the first page
// can renew a reused session while the test is rewriting its expiry and cookies.
for (const age of [23, 25])
  test(`uses default session renewal for a ${age}-hour-old browser session`, async ({
    page,
    context,
  }) => {
    const login = await environment.users.login({ userId: environment.owner.id });
    const current = await environment.auth.api.getSession({ headers: login.headers });

    if (!current) throw new Error("Expected owner session");
    const lifetime = 7 * 24 * 60 * 60;
    expect(current.session.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      (lifetime - 10) * 1000,
    );
    expect(current.session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(lifetime * 1000);
    const { authCookies } = await environment.auth.$context;
    const cookieName = authCookies.sessionToken.name;

    const previousExpiry = new Date(Date.now() + (lifetime - age * 60 * 60) * 1000);
    await environment.database.db
      .update(authSession)
      .set({ expiresAt: previousExpiry })
      .where(eq(authSession.id, current.session.id));
    await context.addCookies(
      login.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        sameSite: "Lax",
        secure: false,
        expires: Math.floor(previousExpiry.getTime() / 1000),
      })),
    );

    const response = await page.goto("/organizations");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Choose an organization" })).toBeVisible();
    const browserCookie = (await context.cookies()).find((cookie) => cookie.name === cookieName);

    const [stored] = await environment.database.db
      .select({ expiresAt: authSession.expiresAt })
      .from(authSession)
      .where(eq(authSession.id, current.session.id));

    if (!browserCookie || !stored) throw new Error("Expected persisted browser session");

    if (age === 23) {
      expect(stored.expiresAt).toEqual(previousExpiry);
      expect(browserCookie.expires).toBe(Math.floor(previousExpiry.getTime() / 1000));
    } else {
      expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan((lifetime - 10) * 1000);
      expect(browserCookie.expires - Date.now() / 1000).toBeGreaterThan(lifetime - 10);
      expect(Math.abs(browserCookie.expires - stored.expiresAt.getTime() / 1000)).toBeLessThan(2);
      expect(browserCookie.httpOnly).toBe(true);
      expect(browserCookie.sameSite).toBe("Lax");
    }
  });

for (const navigation of ["document", "client"])
  test(`clears an expired browser session on ${navigation} navigation and requires sign-in`, async ({
    page,
    context,
  }) => {
    const login = await environment.users.login({ userId: environment.owner.id });
    const current = await environment.auth.api.getSession({ headers: login.headers });

    if (!current) throw new Error("Expected owner session");
    await context.addCookies(
      login.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        sameSite: "Lax",
        secure: false,
      })),
    );

    if (navigation === "client") {
      await page.goto("/");
      await expect(
        page.getByRole("link", { name: "Choose organization: Widefleet" }),
      ).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.dataset["sessionFixture"] = "same-document";
      });
    }

    await environment.database.db
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSession.id, current.session.id));

    if (navigation === "client") {
      await page.getByRole("link", { name: "Choose organization: Widefleet" }).click();
      await page.getByRole("menuitem", { name: "Add organization" }).click();
      await expect(page).toHaveURL(/\/sign-in\?/);
      await expect(page.locator("html")).toHaveAttribute("data-session-fixture", "same-document");
    } else {
      await page.goto("/organizations");
      await expect(page).toHaveURL(/\/sign-in\?next=%2Forganizations$/);
    }

    const { authCookies } = await environment.auth.$context;
    expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain(
      authCookies.sessionToken.name,
    );
  });

test("opens the only organization, ignores a stale session value and explains removed access", async ({
  page,
  context,
}) => {
  const person = environment.users.createUser({
    name: "Organization Reader",
    email: "organization-reader@example.test",
  });

  await environment.users.saveUser(person);
  await environment.linkMicrosoftUser(person.id);
  const login = await environment.users.login({ userId: person.id });
  await context.addCookies(
    login.cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      sameSite: "Lax",
      secure: false,
    })),
  );
  await page.goto("/organizations");
  await expect(page.getByRole("heading", { name: "Choose an organization" })).toBeVisible();
  await page.getByRole("link", { name: "Widefleet Member" }).click();
  await expect(page).toHaveURL("http://localhost:25430/widefleet");
  await expect(page.getByRole("link", { name: "Choose organization: Widefleet" })).toBeVisible();
  await page.goto("/widefleet/catalog/templates");
  await expect(page.getByRole("heading", { name: "Start from a template" })).toBeVisible();
  // Better Auth's organization plugin keeps this column; Widefleet never reads it.
  await environment.database.db
    .update(authSession)
    .set({ activeOrganizationId: "unavailable" })
    .where(eq(authSession.userId, person.id));

  await page.getByRole("link", { name: /^Gmail/ }).click();
  await expect(page).toHaveURL("http://localhost:25430/widefleet/catalog/templates/gmail");
  await expect(page.getByRole("heading", { name: "Gmail" })).toBeVisible();

  // Paths without an organization open the member's only organization.
  const response = await context.request.get("/__data.json");
  expect(await response.json()).toEqual({ type: "redirect", status: 303, location: "/widefleet" });
  await page.goto("/");
  await expect(page).toHaveURL("http://localhost:25430/widefleet");
  await environment.database.db.delete(member).where(eq(member.userId, person.id));
  expect((await page.goto("/widefleet"))?.status()).toBe(404);
  await page.goto("/");
  await expect(
    page.getByText("Your account has no available organizations.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("http://localhost:25430/sign-in");
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

test("renews the browser session cookie while rendering a protected page", async ({
  page,
  context,
}) => {
  const login = await environment.users.login({ userId: environment.owner.id });
  const current = await environment.auth.api.getSession({ headers: login.headers });

  if (!current) throw new Error("Expected owner session");
  await context.addCookies(
    login.cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      sameSite: "Lax",
      secure: false,
    })),
  );
  await environment.database.db
    .update(authSession)
    .set({
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .where(eq(authSession.id, current.session.id));

  const response = await page.goto("/widefleet");
  expect(response?.status()).toBe(200);
  expect(await response?.headerValue("set-cookie")).toMatch(/Max-Age=604800/i);
  const cookie = (await context.cookies()).find((entry) => entry.name.endsWith("session_token"));
  expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000 + 6 * 24 * 60 * 60);
});

test("returns 503 from the session hook when the session store is unavailable", async ({
  context,
}) => {
  const login = await environment.users.login({ userId: environment.owner.id });
  await context.addCookies(
    login.cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      sameSite: "Lax",
      secure: false,
    })),
  );

  // Fail the actual Better Auth adapter in this test's disposable database,
  // including its APIError wrapping, before either page loader can run.
  await environment.database.db.execute(sql`ALTER TABLE "session" RENAME TO "unavailable_session"`);

  try {
    for (const path of ["/organizations", "/organizations/__data.json"]) {
      const response = await context.request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(503);
      expect(await response.text()).toContain("Sign-in is temporarily unavailable.");
      expect(response.headers()["location"]).toBeUndefined();
    }
  } finally {
    await environment.database.db.execute(
      sql`ALTER TABLE "unavailable_session" RENAME TO "session"`,
    );
  }

  expect((await context.request.get("/organizations")).status()).toBe(200);
});

test("shows deployment agents only to administrators", async ({ browser }) => {
  const creator = environment.users.createUser({
    name: "Agent viewer",
    email: "agent-viewer@example.test",
  });

  await environment.users.saveUser(creator);
  await environment.linkMicrosoftUser(creator.id);

  const context = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
    extraHTTPHeaders: { "x-forwarded-proto": "http" },
  });

  const login = await environment.users.login({ userId: creator.id });
  await context.addCookies(
    login.cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      sameSite: "Lax" as const,
      secure: false,
    })),
  );

  try {
    const page = await context.newPage();
    const denied = page.getByRole("heading", { name: "You don't have access to this page." });
    const response = await page.goto("/widefleet/settings/agents");
    expect(response?.status()).toBe(403);
    await expect(denied).toBeVisible();

    await page.goto("/widefleet");
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "/widefleet/settings/agents";
      document.body.append(link);
      link.click();
    });
    await expect(page).toHaveURL(/\/widefleet\/settings\/agents$/);
    await expect(denied).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deployment agents" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("does not show a private page again with Back after sign-out", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
    extraHTTPHeaders: { "x-forwarded-proto": "http" },
  });

  const login = await environment.users.login({ userId: environment.owner.id });
  await context.addCookies(
    login.cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      sameSite: "Lax" as const,
      secure: false,
    })),
  );

  try {
    const created = await context.request.post("/api/v1/apps", {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { slug: "back-after-sign-out", displayName: "Private Back App" },
    });

    expect(created.ok()).toBe(true);
    const page = await context.newPage();
    const response = await page.goto("/widefleet/apps");
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
    await expect(page.getByText("Private Back App")).toBeVisible();
    await page.getByRole("button", { name: /^Account:/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    // Without no-store, the browser shows the stored page instead of asking the server.
    await page.goBack();
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fwidefleet%2Fapps$/);
    await expect(page.getByText("Private Back App")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("protects auth-group documents and data requests even when every layout is reused", async ({
  request,
}) => {
  for (const path of [
    "/",
    "/widefleet/account",
    "/widefleet/settings/agents",
    "/widefleet/apps",
    "/widefleet/apps/new",
    "/widefleet/apps/00000000-0000-4000-8000-000000000000/connections",
    "/widefleet/catalog/templates?q=mail",
    "/widefleet/catalog/templates/gmail",
    "/widefleet/settings/members?q=reader&page=2",
    "/widefleet/services",
    "/widefleet/settings/company-sign-in",
    "/widefleet/welcome",
    "/organizations",
    "/device?user_code=ABCD1234",
  ]) {
    const location = `/sign-in?${new URLSearchParams({ next: path })}`;
    const document = await request.get(path, { maxRedirects: 0 });
    expect(document.status(), path).toBe(303);
    expect(document.headers()["location"], path).toBe(location);

    const data = new URL(path, environment.configuration.PLATFORM_URL);
    data.pathname = `${data.pathname.replace(/\/$/, "")}/__data.json`;
    data.searchParams.set("x-sveltekit-invalidated", "00000");
    const response = await request.get(data.href, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
    expect(await response.json(), path).toEqual({ type: "redirect", status: 303, location });
  }
});

test("keeps public pages, service health and API authentication outside page login redirects", async ({
  request,
}) => {
  for (const path of ["/sign-in", "/recover", "/healthz"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
  }

  const api = await request.get("/api/v1/apps", { maxRedirects: 0 });
  expect(api.status()).toBe(401);
  expect(api.headers()["location"]).toBeUndefined();
  // A path that cannot name an organization has no page.
  expect((await request.get("/missing.html", { maxRedirects: 0 })).status()).toBe(404);
});

test("asks search engines not to index control-plane pages and API responses", async ({
  request,
}) => {
  for (const path of ["/sign-in", "/recover", "/healthz", "/api/v1/apps", "/missing.html"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.headers()["x-robots-tag"], path).toBe("noindex");
  }
});

test("redirects anonymous device requests to login and preserves the code and email", async ({
  page,
}) => {
  await environment.database.db.update(ssoProvider).set({ domainVerified: true });
  await page.goto("/device?user_code=ABCD1234&email=device%40example.test");
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with email", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("next")).toBe(
    "/device?user_code=ABCD1234&email=device%40example.test",
  );
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("device@example.test");
});

test("starts Entra login with a host-only HttpOnly state cookie", async ({ request }) => {
  await environment.database.db.update(ssoProvider).set({ domainVerified: true });

  const response = await request.post("/api/auth/sign-in/sso", {
    headers: { origin: environment.configuration.PLATFORM_URL },
    data: {
      providerId: "microsoft",
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
    `${environment.configuration.PLATFORM_URL}/api/auth/sso/callback/microsoft`,
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

test("requires company SSO and links the matching verified company email without changing membership", async ({
  page,
  context,
}) => {
  const person = environment.users.createUser({
    name: "SSO Test User",
    email: "sso@example.test",
    emailVerified: true,
  });

  await environment.users.saveUser(person);
  await environment.database.db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: "widefleet",
    userId: person.id,
    role: "member",
    createdAt: new Date(),
  });
  const login = await environment.users.login({ userId: person.id });
  await context.addCookies(
    login.cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      sameSite: "Lax",
      secure: false,
    })),
  );
  await environment.database.db.update(ssoProvider).set({ domainVerified: true });

  try {
    // The signed-in member continues to company SSO without another click.
    const authorization = page.waitForRequest(
      (request) => new URL(request.url()).searchParams.get("login_hint") === "sso@example.test",
    );

    await page.goto("/widefleet/account");
    await authorization;
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(page.getByText("You are signed in with your company account.")).toBeVisible();
    expect(await (await page.request.get("/api/v1/me")).json()).toMatchObject({
      id: person.id,
      role: "member",
      admin: false,
    });
    expect((await page.request.get("/api/v1/settings")).status()).toBe(403);
  } finally {
    await environment.database.db.delete(account).where(eq(account.userId, person.id));
    await environment.database.db.delete(member).where(eq(member.userId, person.id));
    await environment.database.db.delete(user).where(eq(user.id, person.id));
  }
});

test("waits for a choice when company SSO just failed or the visitor has no relationship to it", async ({
  browser,
}) => {
  const people = [
    { name: "SSO Member", email: "returning@example.test", member: true },
    { name: "SSO Stranger", email: "stranger@example.test", member: false },
  ].map((fixture) => ({
    fixture,
    person: environment.users.createUser({
      name: fixture.name,
      email: fixture.email,
      emailVerified: true,
    }),
  }));

  for (const { fixture, person } of people) {
    await environment.users.saveUser(person);

    if (fixture.member)
      await environment.database.db.insert(member).values({
        id: crypto.randomUUID(),
        organizationId: "widefleet",
        userId: person.id,
        role: "member",
        createdAt: new Date(),
      });
  }

  await environment.database.db.update(ssoProvider).set({ domainVerified: true });

  const open = async (userId: string, path: string, recentlyStarted = false) => {
    const context = await browser.newContext();
    const login = await environment.users.login({ userId });

    await context.addCookies(
      login.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        sameSite: "Lax" as const,
        secure: false,
      })),
    );

    const page = await context.newPage();
    const starts: string[] = [];

    // Record company sign-in starts without following the identity provider.
    await page.route("**/api/auth/sign-in/sso", async (route) => {
      starts.push(route.request().postData() ?? "");
      await route.abort();
    });

    if (recentlyStarted)
      await page.addInitScript(() =>
        sessionStorage.setItem("widefleet.company-sign-in:widefleet", String(Date.now())),
      );
    await page.goto(path);
    await page.waitForLoadState("networkidle");

    return { context, page, starts };
  };

  const [returning, stranger] = people.map(({ person }) => person.id);

  try {
    for (const visit of [
      // A provider error returns here; starting again would send the browser straight back.
      await open(z.string().parse(returning), "/sign-in?organization=widefleet&error=sso"),
      // So does a sign-in that returned within a minute of starting automatically.
      await open(z.string().parse(returning), "/sign-in?organization=widefleet", true),
      // Linking a signed-in stranger here must not share their address with this provider.
      await open(z.string().parse(stranger), "/sign-in?organization=widefleet"),
    ]) {
      expect(visit.starts).toEqual([]);
      await visit.page.getByRole("button", { name: "Sign in with Microsoft" }).click();
      await expect.poll(() => visit.starts.length).toBe(1);
      await visit.context.close();
    }
  } finally {
    for (const { person } of people) {
      await environment.database.db.delete(member).where(eq(member.userId, person.id));
      await environment.database.db.delete(authSession).where(eq(authSession.userId, person.id));
      await environment.database.db.delete(user).where(eq(user.id, person.id));
    }
  }
});

test("completes Microsoft login against emulate through the built SvelteKit server", async ({
  page,
}) => {
  await environment.database.db.update(ssoProvider).set({ domainVerified: true });
  await page.goto("/sign-in");
  await expect(page.getByLabel("Organization slug")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in with Microsoft" })).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill("sso@EXAMPLE.TEST");
  await page.getByRole("button", { name: "Continue with email", exact: true }).click();
  await page.getByRole("button", { name: /sso@example.test/ }).click();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByText("SSO Test User", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("keeps an SSO error on the email step without requesting an email code", async ({ page }) => {
  await environment.database.db.update(ssoProvider).set({ domainVerified: true });
  let codeRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/email-otp/send-verification-otp")) codeRequests += 1;
  });
  await page.route("**/api/auth/sign-in/sso", (route) =>
    route.fulfill({ status: 503, json: { message: "Company sign-in is unavailable" } }),
  );
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill("sso@example.test");
  await page.getByRole("button", { name: "Continue with email", exact: true }).click();
  await expect(page.getByText("Could not start sign-in. Please try again.")).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveCount(0);
  expect(codeRequests).toBe(0);
});

test("offers Google and Microsoft alongside email and highlights the last successful method", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "platform.last_used_login_method",
      value: "google",
      url: environment.configuration.PLATFORM_URL,
    },
  ]);
  await page.goto("/sign-in?next=%2Fdevice%3Fuser_code%3DSYNTHETIC");
  await expect(
    page.getByRole("button", { name: /^Continue with Google/ }),
  ).toHaveAccessibleDescription("Last used");
  await expect(page.getByRole("button", { name: /^Continue with Microsoft/ })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        await page
          .locator("img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
            ),
          ),
      ).toBe(true);
      await page.screenshot({
        path: fileURLToPath(
          new URL(
            `../../../../.local/playwright/shared-sign-in-${colorScheme}-${width}.png`,
            import.meta.url,
          ),
        ),
        fullPage: true,
      });
    }
  }

  await page.route("**/api/auth/sign-in/social", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      provider: "widefleet-microsoft",
      callbackURL: "/device?user_code=SYNTHETIC",
      errorCallbackURL:
        "/sign-in/connect?provider=microsoft&next=%2Fdevice%3Fuser_code%3DSYNTHETIC",
    });
    await route.fulfill({ status: 503, json: { message: "Synthetic provider failure" } });
  });
  await page.getByRole("button", { name: /^Continue with Microsoft/ }).click();
  await expect(page.getByRole("alert")).toContainText("Could not start sign-in");
  await expect(page.getByRole("button", { name: /^Continue with Google/ })).toBeEnabled();
});

test("shows email confirmation only for missing provider proof and handles cancellation", async ({
  page,
}) => {
  await page.goto("/sign-in/connect?provider=microsoft&next=%2Fapps&error=account_not_linked");
  await expect(page.getByRole("heading", { name: "Connect Microsoft" })).toBeVisible();
  await expect(page.getByText("Confirm your Widefleet email once", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await page.goto("/sign-in/connect?provider=google&next=%2Fapps&error=access_denied");
  await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled");
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to sign-in" }).click();
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapps$/);
});

test("offers configured social providers when email delivery is unavailable", async ({ page }) => {
  const origin = "http://localhost:25435";
  let output = "";

  const socialOnly = spawn(process.execPath, ["build"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...process.env,
      ...environment.environment,
      PLATFORM_URL: origin,
      LOGIN_CODE_DELIVERY: "email",
      GOOGLE_CLIENT_ID: "synthetic-google-client",
      GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
      MICROSOFT_CLIENT_ID: "synthetic-microsoft-client",
      MICROSOFT_CLIENT_SECRET: "synthetic-microsoft-secret",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "25435",
      PROTOCOL_HEADER: "x-forwarded-proto",
      SHUTDOWN_TIMEOUT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  socialOnly.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  socialOnly.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });

  try {
    await expect
      .poll(
        async () => {
          if (socialOnly.exitCode !== null) throw new Error(output);

          try {
            return (await fetch(`${origin}/healthz`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    await page.goto(`${origin}/sign-in`);
    await expect(page.getByRole("button", { name: /^Continue with Google/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Continue with Microsoft/ })).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
    await expect(page.getByText("or continue with email", { exact: true })).toHaveCount(0);
    await page.goto(`${origin}/sign-in/connect?provider=microsoft&error=account_not_linked`);
    await expect(page.getByRole("alert")).toContainText("Email confirmation is unavailable");
  } finally {
    if (socialOnly.exitCode === null) {
      socialOnly.kill("SIGTERM");
      await once(socialOnly, "exit");
    }
  }
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
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
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

  await page.goto("/widefleet/settings/agents");
  await page.getByText("Register deployment agent", { exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Local deployment host");
  await page.getByRole("button", { name: "Register agent" }).click();
  await expect(page.getByRole("status")).toContainText("agent_");
  await page.goto("/widefleet/settings/agents");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("link", { name: "My apps", exact: true }).click();
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
    `/widefleet/apps/${appId}`,
  );
  await expect(page.getByText("notes-preview.apps.localhost", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "App settings", exact: true }).click();
  await page.getByText("Permanently delete app", { exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Delete app", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My apps", exact: true })).toBeVisible();
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
    await memberPage.goto("/widefleet/apps");
    await expect(memberPage.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
    expect((await memberContext.request.get("/widefleet/settings/members")).status()).toBe(403);
    await memberPage.getByRole("link", { name: "Create app", exact: true }).click();
    await memberPage.getByLabel("App name", { exact: true }).fill("Member Workspace");
    await memberPage.getByLabel("URL slug").fill("member-workspace");
    await memberPage.getByRole("button", { name: "Create app" }).click();
    await expect(memberPage.getByRole("heading", { level: 1 })).toHaveText("Member Workspace");

    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Members", exact: true }).click();
    await page.getByLabel("Search by name or email").fill("member-ui@");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Role for Member Example" }).click();

    const promoted = page.waitForResponse(
      (response) =>
        response.url().includes("/_app/remote/") && response.request().method() === "POST",
    );

    await page.getByRole("option", { name: "Admin", exact: true }).click();
    expect((await promoted).ok()).toBe(true);
    await memberPage
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "My apps", exact: true })
      .click();
    await expect(memberPage).toHaveURL(/\/apps$/);
    // Another member's role change reaches an open workspace when it next loads.
    await memberPage.reload();
    await expect(memberPage.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(
      memberPage
        .getByRole("button", { name: /^Account:/ })
        .getByText("Administrator", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Role for Member Example" }).click();

    const demoted = page.waitForResponse(
      (response) =>
        response.url().includes("/_app/remote/") && response.request().method() === "POST",
    );

    await page.getByRole("option", { name: "Member", exact: true }).click();
    expect((await demoted).ok()).toBe(true);
    expect((await memberContext.request.get("/widefleet/settings/members")).status()).toBe(403);

    await memberPage.getByRole("link", { name: "Create app", exact: true }).click();
    await expect(memberPage).toHaveURL(/\/apps\/new$/);
    await memberPage.reload();
    await expect(memberPage.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
    await expect(
      memberPage.getByRole("button", { name: /^Account:/ }).getByText("Member", { exact: true }),
    ).toBeVisible();

    await page.goto("/widefleet/apps");
    await page.getByRole("link", { name: "Team Notes", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Team Notes");
    const appPath = new URL(page.url()).pathname;
    expect((await memberContext.request.get(appPath)).status()).toBe(404);

    for (const section of [
      "deployments",
      "connections",
      "workflows",
      "access",
      "access/management",
      "settings",
    ])
      expect((await memberContext.request.get(`${appPath}/${section}`)).status()).toBe(404);
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
    await memberPage.getByRole("link", { name: "Connections", exact: true }).click();
    await expect(memberPage.getByRole("heading", { name: "Nothing here yet." })).toBeVisible();
    expect((await memberContext.request.get(appPath)).status()).toBe(404);
  } finally {
    await memberContext.close();
  }
});

test("saves a role on selection and restores it when saving fails", async ({ page, context }) => {
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

  for (let index = 0; index < 50; index += 1) {
    const person = environment.users.createUser({
      name: `Role Page ${String(index).padStart(2, "0")}`,
      email: `role-page-${index}@example.test`,
    });

    await environment.users.saveUser(person);
    await environment.linkMicrosoftUser(person.id);
  }

  const target = environment.users.createUser({
    name: "Role Page Target",
    email: "role-page-target@example.test",
  });

  await environment.users.saveUser(target);
  await environment.linkMicrosoftUser(target.id);
  // Hold each role change at the network to see what the page shows before the server answers.
  const held: (() => void)[] = [];

  const release = async () => {
    await expect.poll(() => held.length).toBe(1);
    held.shift()?.();
  };

  await page.route("**/_app/remote/**", async (route) => {
    if (route.request().method() !== "POST") return route.continue();

    await new Promise<void>((resolve) => held.push(resolve));

    return route.continue();
  });
  await page.goto("/widefleet/settings/members?q=Role+Page&page=2");
  const role = page.getByRole("button", { name: "Role for Role Page Target" });
  const row = page.getByRole("listitem").filter({ hasText: "role-page-target@example.test" });
  const height = (await row.boundingBox())?.height;
  await role.click();
  await page.getByRole("option", { name: "Admin", exact: true }).click();
  // The new role is its own confirmation; the picker stays usable while the server saves it.
  await expect(role).toHaveText("Admin");
  await expect(role).toBeEnabled();
  await release();
  await expect
    .poll(async () =>
      environment.database.db
        .select({ role: member.role })
        .from(member)
        .where(eq(member.userId, target.id)),
    )
    .toEqual([{ role: "admin" }]);
  await expect(role).toHaveText("Admin");
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("page")).toBe("2");

  // Two quick choices reach the server in order, so the later one is kept.
  await role.click();
  await page.getByRole("option", { name: "Member", exact: true }).click();
  await role.click();
  await page.getByRole("option", { name: "Admin", exact: true }).click();
  await expect(role).toHaveText("Admin");
  await release();
  await expect
    .poll(async () =>
      environment.database.db
        .select({ role: member.role })
        .from(member)
        .where(eq(member.userId, target.id)),
    )
    .toEqual([{ role: "member" }]);
  await expect(role).toHaveText("Admin");
  await release();
  await expect
    .poll(async () =>
      environment.database.db
        .select({ role: member.role })
        .from(member)
        .where(eq(member.userId, target.id)),
    )
    .toEqual([{ role: "admin" }]);
  await expect(role).toHaveText("Admin");

  // The membership ends while the page is open, so the server rejects the change.
  await environment.database.db.delete(member).where(eq(member.userId, target.id));
  await role.click();
  await page.getByRole("option", { name: "Member", exact: true }).click();
  await expect(role).toHaveText("Member");
  await release();
  await expect(page.getByText("Could not change the role of Role Page Target.")).toBeVisible();
  await expect(role).toHaveText("Admin");
  // The explanation arrives as a toast, so the row keeps its size.
  expect((await row.boundingBox())?.height).toBe(height);
});

test("submits a selective Workflow restart and waits for the agent's confirmation", async ({
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
    data: { slug: "workflow-restart-ui", displayName: "Workflow Restart Example" },
  });

  expect(created.ok()).toBe(true);
  const record = app.parse(await created.json());
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
        bindings: [
          { type: "workflow", name: "WORKFLOW", workflow_name: "example", class_name: "Example" },
        ],
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
    status: "succeeded",
    finishedAt: new Date(),
  });
  await environment.database.db
    .update(apps)
    .set({ state: "active", activeDeploymentId: deploymentId })
    .where(eq(apps.id, record.id));
  await page.goto(`/widefleet/apps/${record.id}/workflows`, { waitUntil: "networkidle" });
  await page.getByLabel("Action", { exact: true }).selectOption("restartFrom");
  await page.getByLabel("Instance ID", { exact: true }).fill("run-1");
  await page.getByLabel("Step name", { exact: true }).fill("approval");
  await expect(page.getByLabel("Occurrence", { exact: true })).toHaveValue("1");
  await expect(page.getByLabel("Step type", { exact: true })).toHaveValue("do");
  await page.getByLabel("Occurrence", { exact: true }).fill("2");
  await page.getByLabel("Step type", { exact: true }).selectOption("waitForEvent");
  await page.getByRole("button", { name: "Run action", exact: true }).click();
  await expect(page.getByText("Requested — waiting for the agent.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Processing request …", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Step name", { exact: true })).toBeDisabled();

  const [job] = await environment.database.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.appId, record.id), eq(jobs.kind, "workflows")));

  expect(job?.workflow).toEqual({
    action: "restart",
    workflow: "example",
    id: "run-1",
    from: { name: "approval", count: 2, type: "waitForEvent" },
  });

  if (!job) throw new Error("Missing Workflow request");
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page.getByText(job.id, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Processing request …", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await environment.database.db
    .update(jobs)
    .set({
      state: "succeeded",
      result: {
        leaseToken: crypto.randomUUID(),
        outcome: "succeeded",
        message: "Restarted",
        workflow: { restarted: "run-1" },
      },
    })
    .where(eq(jobs.id, job.id));
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page.getByText("Request completed.", { exact: true })).toBeVisible();
  await expect(page.getByText(job.id, { exact: true })).toBeVisible();
  await expect(page.locator("#workflows pre")).toContainText('"restarted": "run-1"');
  await expect(page.getByRole("button", { name: "Run action", exact: true })).toBeEnabled();
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page.locator("#workflows pre")).toContainText('"restarted": "run-1"');
  expect(dialogs).toEqual([]);
  expect(
    await environment.database.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.appId, record.id), eq(jobs.kind, "workflows"))),
  ).toEqual([{ id: job.id }]);
  await page.getByLabel("Action", { exact: true }).selectOption("restart");
  await expect(page.getByLabel("Step name", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Previously completed steps will run again.", { exact: true }),
  ).toBeVisible();
});

test("confirms discarded workflow drafts on section, history and document navigation", async ({
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
    data: { slug: "navigation-drafts", displayName: "Navigation drafts" },
  });

  expect(created.ok()).toBe(true);
  const record = app.parse(await created.json());
  await page.goto(`/widefleet/apps/${record.id}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/widefleet/apps/${record.id}/workflows$`));
  await page.getByLabel("Action", { exact: true }).selectOption("create");
  await page.getByLabel("Parameters (JSON)").fill('{"draft":true}');

  for (const navigate of [
    async () => {
      await page.getByRole("link", { name: "Connections", exact: true }).click();
    },
    async () => {
      await page.getByRole("main").getByRole("link", { name: "My apps", exact: true }).click();
    },
    async () => {
      await page.goBack();
    },
  ]) {
    const dialog = page.waitForEvent("dialog");
    const navigation = navigate();
    const confirmation = await dialog;
    expect(confirmation.type()).toBe("confirm");
    expect(confirmation.message()).toContain("unsaved changes");
    await confirmation.dismiss();
    await navigation;
    await expect(page).toHaveURL(new RegExp(`/widefleet/apps/${record.id}/workflows$`));
    await expect(page.getByLabel("Parameters (JSON)")).toHaveValue('{"draft":true}');
  }

  // Browser reload and closure use the browser's own confirmation.
  const reloadDialog = page.waitForEvent("dialog");
  const reload = page.evaluate(() => window.location.reload());
  const reloadConfirmation = await reloadDialog;
  expect(reloadConfirmation.type()).toBe("beforeunload");
  await reloadConfirmation.dismiss();
  await reload;
  await expect(page.getByLabel("Parameters (JSON)")).toHaveValue('{"draft":true}');
  const closeDialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const closeConfirmation = await closeDialog;
  expect(closeConfirmation.type()).toBe("beforeunload");
  await closeConfirmation.dismiss();
  expect(page.isClosed()).toBe(false);

  const discardDialog = page.waitForEvent("dialog");
  const leave = page.goBack();
  await (await discardDialog).accept();
  await leave;
  await expect(page).toHaveURL(new RegExp(`/widefleet/apps/${record.id}$`));
  await expect(
    page.getByRole("heading", { name: "Ready for your first deployment." }),
  ).toBeVisible();
  await page.goForward();
  await expect(page.getByLabel("Action", { exact: true })).toHaveValue("list");
  await page.getByLabel("Action", { exact: true }).selectOption("create");
  await expect(page.getByLabel("Parameters (JSON)")).toHaveValue("{}");
  await page.getByLabel("Action", { exact: true }).selectOption("list");

  // Reverting the edits restores clean navigation; no confirmation is needed.
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  expect(dialogs).toEqual([]);
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

  await page.goto(`/widefleet/apps/${record.id}/deployments`);
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

test.describe(`app catalog`, () => {
  test.use({});

  test("publishes and withdraws apps for members without granting management access", async ({
    page,
    context,
    browser,
    request,
  }) => {
    await page.goto("/widefleet");
    await expect(page).toHaveURL(/\/sign-in\?next=/);
    expect(new URL(page.url()).searchParams.get("next")).toBe("/widefleet");

    const creator = environment.users.createUser({
      name: "Catalog Creator",
      email: `catalog-creator@example.test`,
    });

    const reader = environment.users.createUser({
      name: "Catalog Reader",
      email: `catalog-reader@example.test`,
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
        slug: `catalog`,
        displayName: `Catalog App`,
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
      await readerPage.goto("/widefleet/apps");
      await expect(readerPage.getByRole("link", { name: "Create app", exact: true })).toBeVisible();
      await expect(
        readerPage.getByRole("heading", { name: "Start from a template" }),
      ).toBeVisible();
      await readerPage.getByRole("link", { name: "Home", exact: true }).click();
      await expect(readerPage.getByRole("heading", { level: 1 })).toHaveText("Home");
      await expect(readerPage.getByRole("link", { name: record.displayName })).toHaveCount(0);

      await page.goto(`/widefleet/apps/${record.id}/settings`);

      const publish = page.getByRole("button", {
        name: "Publish to catalog",
        exact: true,
      });

      const form = page.locator("form").filter({ has: publish });
      const action = z.string().parse(await form.getAttribute("action"));
      const remote = z.string().parse(new URL(action, origin).searchParams.get("/remote"));
      const queryUrl = organizationQuery(`/_app/remote/${remote.split("/")[0]}/getCatalog`);
      const anonymous = await request.get(queryUrl);
      expect(await remoteRedirect(anonymous)).toBe("/sign-in");

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

      // The owner writes the description under the app's name; it appears with the app on Home.
      const describe = page.getByRole("button", { name: "Edit description" });
      await describe.click();
      const field = page.getByRole("textbox", { name: "Description", exact: true });
      await expect(field).toBeFocused();
      // Save and Discard appear once the text changes, and Discard returns to the saved text.
      const save = page.getByRole("button", { name: "Save description", exact: true });
      await expect(save).toHaveCount(0);
      await field.fill("A draft");
      await page.getByRole("button", { name: "Discard changes", exact: true }).click();
      await expect(describe).toBeFocused();
      await expect(page.getByText("Add a description", { exact: true })).toBeVisible();
      await page.keyboard.press("Enter");
      await field.fill("Counts the stock.");
      await save.click();
      await expect(page.getByText("Counts the stock.", { exact: true })).toBeVisible();
      await expect(describe).toBeFocused();
      await readerPage.reload();
      await expect(readerPage.getByRole("link", { name: record.displayName })).toHaveAttribute(
        "href",
        record.url,
      );
      await expect(readerPage.getByText("Counts the stock.", { exact: true })).toBeVisible();
      expect((await readerContext.request.get(`/widefleet/apps/${record.id}`)).status()).toBe(404);
      expect((await readerContext.request.get(`/api/v1/apps/${record.id}`)).status()).toBe(404);
      const catalog = await readerContext.request.get(queryUrl);
      expect(catalog.headers()["cache-control"]).toBe("private, no-store");
      expect(await catalog.text()).toContain(record.displayName);

      // The owner renames the app in its heading; Escape keeps the name, Enter saves a new one.
      const rename = page.getByRole("button", { name: "Edit name" });
      await rename.click();
      const title = page.getByRole("textbox", { name: "Name", exact: true });
      await title.fill("A draft");
      await page.keyboard.press("Escape");
      await expect(rename).toBeFocused();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Catalog App");
      await page.keyboard.press("Enter");
      await title.fill("Stock Counter");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stock Counter");
      await expect(page).toHaveTitle("Stock Counter · Widefleet");
      await readerPage.reload();
      await expect(readerPage.getByRole("link", { name: "Stock Counter" })).toBeVisible();

      await page.getByRole("button", { name: "Remove from catalog", exact: true }).click();
      await expect(publish).toBeVisible();
      await readerPage.reload();
      await expect(readerPage.getByRole("link", { name: "Stock Counter" })).toHaveCount(0);
    } finally {
      await readerContext.close();
    }
  });
});

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
  await page.goto("/widefleet/settings/agents");
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
  const queryUrl = organizationQuery(`/_app/remote/${module}/getApps`);
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
  expect(await remoteRedirect(anonymous)).toBe("/sign-in");

  // Remote callers control their page-context headers. Neither an auth-group
  // page nor a public page may replace the remote function's own authorization.
  for (const pathname of ["/widefleet/settings/agents", "/sign-in"]) {
    const response = await request.get(queryUrl, {
      headers: { "x-sveltekit-pathname": pathname },
      maxRedirects: 0,
    });

    expect(response.headers()["location"]).toBeUndefined();
    expect(await remoteRedirect(response)).toBe("/sign-in");
  }

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
  // The session remains valid, but its organization membership has been removed.
  expect(await remoteRedirect(expired)).toBe("/organizations");
});

test(`edits app and inherited preview access`, async ({ browser }) => {
  const [owner] = await environment.database.db
    .select()
    .from(member)
    .where(eq(member.role, "owner"));

  if (!owner) throw new Error("Expected initial owner");
  const session = await environment.users.login({ userId: owner.userId });

  const context = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
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
    const slug = `access-ui`;

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

    await page.route(
      "**/_app/immutable/entry/start.*.js",
      async (route) => {
        await ready;
        await route.continue();
      },
      { times: 1 },
    );

    await page.goto(`/widefleet/apps/${parent.id}/access`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Allowed groups for this app", { exact: true }).fill("finance");
    hydration.emit("ready");

    // Finish loading the held client scripts after editing the server-rendered form.
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel("Allowed groups for this app", { exact: true })).toHaveValue(
      "finance",
    );

    const submission = new EventEmitter();
    const resume = once(submission, "resume");

    await page.route(
      "**/*changeAppAccess*",
      async (route) => {
        await resume;
        await route.continue();
      },
      { times: 1 },
    );

    await page.getByRole("button", { name: "Save app rules", exact: true }).click();

    try {
      await expect(page.getByLabel("Allowed groups for this app", { exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Saving …", exact: true })).toBeDisabled();
    } finally {
      submission.emit("resume");
    }

    await expect
      .poll(async () => {
        const response = await context.request.get(`/api/v1/apps/${parent.id}/access`);

        return z.object({ groups: z.array(z.string()) }).parse(await response.json()).groups;
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
    await page.goto(`/widefleet/apps/${preview.id}/access`);
    await expect(
      page.getByText(
        "This preview automatically inherits the original app's access rules. You cannot set separate rules.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Allowed groups: finance", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save app rules", exact: true })).toHaveCount(0);
    // This phase edits the hydrated form; the first visit covers pre-hydration input.
    await page.goto(`/widefleet/apps/${parent.id}/access`, { waitUntil: "networkidle" });
    await page.getByLabel("Allowed groups for this app", { exact: true }).fill("unsaved-group");

    const competing = await context.request.patch(`/api/v1/apps/${parent.id}/access`, {
      headers: { origin: environment.configuration.PLATFORM_URL },
      data: { groups: ["qa"], revision: 1 },
    });

    expect(competing.status()).toBe(200);

    for (const name of ["Management access", "Overview"]) {
      const dialog = page.waitForEvent("dialog");
      const navigation = page.getByRole("link", { name, exact: true }).click();
      const confirmation = await dialog;
      expect(confirmation.type()).toBe("confirm");
      await confirmation.dismiss();
      await navigation;
      await expect(page).toHaveURL(new RegExp(`/widefleet/apps/${parent.id}/access$`));
      await expect(page.getByLabel("Allowed groups for this app", { exact: true })).toHaveValue(
        "unsaved-group",
      );
    }

    const refreshed = page.waitForResponse((response) => response.url().includes("/getAppAccess"));

    await page.getByRole("link", { name: "Refresh status", exact: true }).click();
    await refreshed;

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
      expect(await response.json()).toMatchObject({ groups: ["qa"], revision: 2 });
    }

    const dialog = page.waitForEvent("dialog");

    const navigation = page.getByRole("link", { name: "Management access", exact: true }).click();

    const confirmation = await dialog;
    expect(confirmation.type()).toBe("confirm");
    await confirmation.accept();
    await navigation;
    await expect(page.getByRole("heading", { name: "Manage access" })).toBeVisible();
    await page.getByRole("link", { name: "App usage", exact: true }).click();

    await expect(page.getByLabel("Allowed groups for this app", { exact: true })).toHaveValue("qa");

    await expect(page.locator('input[name^="n:revision/"]')).toHaveValue("2");

    await page.getByLabel("Allowed groups for this app", { exact: true }).fill("");
    await page.getByRole("button", { name: "Save app rules", exact: true }).click();
    await expect
      .poll(async () => {
        const response = await context.request.get(`/api/v1/apps/${preview.id}/access`);

        return z.object({ groups: z.array(z.string()) }).parse(await response.json()).groups;
      })
      .toEqual([]);
    await page.goto(`/widefleet/apps/${preview.id}/access`);
    await expect(
      page.getByText("Allowed groups: All signed-in users", { exact: true }),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

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

  test("shows app favicons with stable fallbacks on desktop and mobile", async ({
    page,
    context,
  }) => {
    const cases = ["valid", "missing", "broken", "service", "unpublished"];
    const iconRequests: string[] = [];

    for (const kind of cases) {
      const response = await context.request.post("/api/v1/apps", {
        headers: { origin: environment.configuration.PLATFORM_URL },
        data: { slug: `icon-${kind}`, displayName: `Icon ${kind}` },
      });

      expect(response.ok()).toBe(true);
      const record = app.parse(await response.json());

      if (kind !== "unpublished")
        await environment.database.db
          .update(apps)
          .set({
            state: "active",
            activeDeploymentId: crypto.randomUUID(),
            webEnabled: kind !== "service",
          })
          .where(eq(apps.id, record.id));
      await page.route(`**/widefleet/apps/${record.id}/icon?*`, (route) => {
        iconRequests.push(kind);

        return route.fulfill({
          status: kind === "missing" ? 404 : 200,
          contentType: "image/svg+xml",
          body:
            kind === "valid"
              ? '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="48" height="24" fill="red"/></svg>'
              : "not an image",
        });
      });
    }

    await page.goto("/widefleet/apps?q=Icon");
    await expect(page.getByRole("heading", { name: "My apps", exact: true })).toBeVisible();
    await expect(page.locator("header").getByText("Widefleet", { exact: true })).toHaveCount(1);
    const rows = page.getByRole("list", { name: "Apps" }).getByRole("listitem");
    const valid = rows.filter({ hasText: "Icon valid" }).locator("img");
    await expect(valid).toBeVisible();
    await expect(valid).toHaveCSS("width", "24px");
    await expect(valid).toHaveCSS("height", "24px");
    await expect(valid).toHaveCSS("object-fit", "contain");

    for (const kind of cases.filter((value) => value !== "valid")) {
      const row = rows.filter({ hasText: `Icon ${kind}` });
      await expect(row.locator("svg.lucide-layers-2")).toBeVisible();
      await expect(row.locator("img")).toBeHidden();
    }

    expect(iconRequests.sort()).toEqual(["broken", "missing", "valid"]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(valid).toBeVisible();
    await rows.filter({ hasText: "Icon valid" }).getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Icon valid");
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
    await page.goto("/widefleet/apps");
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
    await expect(page).toHaveURL(new RegExp(`/widefleet/apps/${record.id}/access/management$`));
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
      .getByRole("link", { name: "My apps", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "My apps", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.getByText("Menu", { exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Company sign-in", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.goto("/widefleet/apps/new");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.getByText("Create as preview", { exact: false }).click();
    await expect(page.getByLabel("Preview of an existing app")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });

  test("supports keyboard navigation, system appearance, and copying an exact deployment command", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.emulateMedia({ colorScheme: "light" });

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
    await expect(page.getByRole("menuitem", { name: /appearance/i })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(accountMenu).toBeFocused();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.goto(`/widefleet/apps/${record.id}`);
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
    await page.goto(`/widefleet/apps/${record.id}/deployments`);
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
    await page.goto("/widefleet/settings/agents");

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
    await page.goto(`/widefleet/apps/new?parent=${parent.id}`);
    await expect(page.getByLabel("Preview of an existing app")).toHaveValue(parent.id);

    const removed = await context.request.delete(`/api/v1/apps/${parent.id}`, {
      headers: { origin: environment.configuration.PLATFORM_URL },
    });

    expect(removed.ok()).toBe(true);

    for (const parentId of [parent.id, preview.id, crypto.randomUUID(), ""]) {
      const response = await page.goto(`/widefleet/apps/new?parent=${parentId}`);
      expect(response?.status()).toBe(404);
      await expect(page.getByLabel("App name", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Back to overview", exact: true })).toBeVisible();
    }

    await page.goto("/widefleet/apps/new");
    await expect(page.getByLabel("App name", { exact: true })).toBeVisible();
  });
});

test("focuses code entry and returns to the same email without another send", async ({ page }) => {
  let sent = 0;
  await page.route("**/api/auth/email-otp/send-verification-otp", async (route) => {
    sent += 1;
    expect(route.request().postDataJSON()).toMatchObject({ email: "reader@example.test" });
    await route.fulfill({ json: { success: true } });
  });
  await page.route("**/api/auth/sign-in/email-otp", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      email: "reader@example.test",
      otp: "123456",
    });
    await route.fulfill({ status: 401, json: { message: "Invalid code" } });
  });
  await page.goto("/sign-in?next=%2Fdevice%3Fuser_code%3DSYNTHETIC");
  await expect(
    page.getByText("Sign in to review the request from your terminal", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("Reader@EXAMPLE.TEST");
  await page.getByLabel("Email", { exact: true }).press("Enter");
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Continue with Google/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Continue with Microsoft/ })).toHaveCount(0);
  await expect(page.getByText("reader@example.test", { exact: true })).toBeVisible();
  const code = page.getByLabel("Sign-in code", { exact: true });
  await expect(code).toBeFocused();
  await expect(page.getByRole("button", { name: "Verify and sign in" })).toBeDisabled();
  await code.fill("123456");
  await code.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Invalid or expired code");
  await expect(code).toHaveValue("123456");
  await expect(code).toBeFocused();
  await page.getByRole("button", { name: "Change", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("reader@example.test");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Continue with Google/ })).toBeVisible();
  expect(sent).toBe(1);
  expect(new URL(page.url()).searchParams.get("next")).toBe("/device?user_code=SYNTHETIC");
});

test("resends a code in place and retains the current code when resend fails", async ({ page }) => {
  await page.clock.install();
  let sent = 0;
  await page.route("**/api/auth/email-otp/send-verification-otp", async (route) => {
    sent += 1;
    expect(route.request().postDataJSON()).toMatchObject({ email: "reader@example.test" });
    await route.fulfill(
      sent === 2
        ? { status: 503, json: { message: "Temporarily unavailable" } }
        : { json: { success: true } },
    );
  });
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill("reader@example.test");
  await page.getByRole("button", { name: "Continue with email", exact: true }).click();
  const code = page.getByLabel("Sign-in code", { exact: true });
  await expect(code).toBeVisible();
  await code.fill("123456");
  await expect(page.getByRole("button", { name: /^Resend in/ })).toBeDisabled();
  await page.clock.runFor(31_000);
  await page.getByRole("button", { name: "Resend code", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not send a sign-in code");
  await expect(code).toHaveValue("123456");
  await expect(code).toBeFocused();
  await page.getByRole("button", { name: "Resend code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("A new code has been requested.");
  await expect(code).toHaveValue("");
  await expect(code).toBeFocused();
  await expect(page.getByRole("button", { name: /^Resend in/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Verify and sign in" })).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(sent).toBe(3);
});

test("keeps the email step usable after a failed send and clears feedback on back", async ({
  page,
}) => {
  let sent = 0;
  await page.route("**/api/auth/email-otp/send-verification-otp", async (route) => {
    sent += 1;
    await route.fulfill(
      sent === 1
        ? { status: 503, json: { message: "Temporarily unavailable" } }
        : { json: { success: true } },
    );
  });
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill("reader@example.test");
  await page.getByRole("button", { name: "Continue with email", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not send a sign-in code");
  await expect(page.getByLabel("Email", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("reader@example.test");
  await expect(page.getByRole("heading", { name: "Check your email" })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue with email", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to sign in", exact: true }).click();
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
  expect(sent).toBe(2);
});

test.describe(`app templates`, () => {
  test.use({});

  test("installs a template with its required secrets and shows them on the Secrets page", async ({
    page,
    context,
  }, testInfo) => {
    const person = environment.users.createUser({
      name: "Template Installer",
      email: `template-installer@example.test`,
    });

    await environment.users.saveUser(person);
    await environment.linkMicrosoftUser(person.id);
    const session = await environment.users.login({ userId: person.id });
    await context.addCookies(
      session.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        sameSite: "Lax",
        secure: false,
      })),
    );

    const shoot = async (name: string) => {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });

        for (const colorScheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          await page.screenshot({
            path: testInfo.outputPath(`${name}-${width}-${colorScheme}.png`),
            fullPage: true,
          });
        }
      }

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
    };

    await page.goto("/widefleet/catalog/templates/gmail");
    await expect(
      page.getByRole("heading", { name: "Required secrets", exact: true }),
    ).toBeVisible();

    const install = page.getByRole("button", { name: "Install", exact: true });
    const clientId = page.getByLabel("GOOGLE_CLIENT_ID", { exact: true });
    const clientSecret = page.getByLabel("GOOGLE_CLIENT_SECRET", { exact: true });

    // Install waits for every value, which stays hidden.
    await expect(clientId).toHaveAttribute("type", "password");
    await expect(install).toBeDisabled();
    await shoot("template-install");
    await clientId.fill("synthetic-client-id.apps.example.test");
    await expect(install).toBeDisabled();
    await clientSecret.fill("synthetic-client-secret");
    await expect(install).toBeEnabled();
    await shoot("template-install-filled");
    await clientSecret.press("Enter");

    await expect(page).toHaveURL(/\/widefleet\/apps\/[0-9a-f-]+\/deployments$/);
    const appId = z.uuid().parse(page.url().split("/").at(-2));

    const [installed] = await environment.database.db
      .select({ secrets: apps.secrets, templateId: apps.templateId })
      .from(apps)
      .where(eq(apps.id, appId));

    expect(installed?.templateId).toBe("gmail");
    expect(Object.keys(storedAppSecrets.parse(installed?.secrets)).sort()).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]);
    // Stored encrypted.
    expect(JSON.stringify(installed?.secrets)).not.toContain("synthetic-client-secret");

    // Both secrets are set and required by the installed version.
    await page.goto(`/widefleet/apps/${appId}/secrets`);
    const rows = page.locator("section form, section > div.rounded-lg");
    await expect(page.getByText("Required", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Missing", { exact: true })).toHaveCount(0);
    await shoot("secrets-required");

    // Removing one leaves it missing, with a shortcut to set it again.
    await rows
      .filter({ hasText: "GOOGLE_CLIENT_SECRET" })
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(page.getByText("Missing", { exact: true })).toBeVisible();
    await expect(page.getByText("The app requires secrets that are not set.")).toBeVisible();
    await page.getByRole("button", { name: "Set value", exact: true }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("GOOGLE_CLIENT_SECRET");
    await expect(page.getByLabel("Value", { exact: true })).toBeFocused();
    await shoot("secrets-missing");
    await page.getByLabel("Value", { exact: true }).fill("synthetic-client-secret");
    await page.getByRole("button", { name: "Save secret", exact: true }).click();
    await expect(page.getByText("Missing", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Required", { exact: true })).toHaveCount(2);
  });

  test("keeps My apps and the template list usable while templates are unavailable", async ({
    page,
    context,
  }) => {
    const person = environment.users.createUser({
      name: "Template Outage",
      email: `template-outage@example.test`,
    });

    await environment.users.saveUser(person);
    await environment.linkMicrosoftUser(person.id);
    const session = await environment.users.login({ userId: person.id });
    await context.addCookies(
      session.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        sameSite: "Lax",
        secure: false,
      })),
    );

    const unavailable = page.getByText("Templates are unavailable right now. Try again later.", {
      exact: true,
    });

    await writeFile(templateOutage, "");

    try {
      // A member without apps sees the templates on My apps.
      const mine = await page.goto("/widefleet/apps");
      expect(mine?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "My apps", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Create app", exact: true })).toBeVisible();
      await expect(
        page.getByRole("searchbox", { name: "Search templates", exact: true }),
      ).toBeVisible();
      await expect(unavailable).toBeVisible();

      const list = await page.goto("/widefleet/catalog/templates");
      expect(list?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "Templates", exact: true })).toBeVisible();
      await expect(
        page.getByRole("main").getByRole("link", { name: "My apps", exact: true }),
      ).toBeVisible();
      await expect(unavailable).toBeVisible();
    } finally {
      await rm(templateOutage, { force: true });
    }

    await page.reload();
    await expect(unavailable).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Gmail", exact: true })).toBeVisible();
  });

  test("lets a member find a template and copy its setup prompt", async ({
    page,
    context,
    request,
  }, testInfo) => {
    await page.goto("/widefleet/catalog/templates/gmail");
    await expect(page).toHaveURL(/\/sign-in\?next=/);
    expect(new URL(page.url()).searchParams.get("next")).toBe("/widefleet/catalog/templates/gmail");
    expect((await request.get("/api/v1/catalog/templates")).status()).toBe(401);

    const person = environment.users.createUser({
      name: "Template Reader",
      email: `template-reader@example.test`,
    });

    await environment.users.saveUser(person);
    await environment.linkMicrosoftUser(person.id);
    const session = await environment.users.login({ userId: person.id });
    await context.addCookies(
      session.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        sameSite: "Lax",
        secure: false,
      })),
    );
    const before = await environment.database.db.select({ id: apps.id }).from(apps);
    const catalog = await context.request.get("/api/v1/catalog/templates");
    expect(catalog.status()).toBe(200);

    await page.goto("/widefleet/catalog/templates");
    await expect(page.getByRole("heading", { name: "Start from a template" })).toBeVisible();

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });

      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /dark/ : "");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`templates-${width}-${colorScheme}.png`),
          fullPage: true,
        });
      }
    }

    await page.getByRole("searchbox", { name: "Search templates", exact: true }).fill("PRIVATE");
    await page.getByRole("searchbox", { name: "Search templates", exact: true }).press("Enter");
    await expect(page.getByRole("heading", { name: "GitHub", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Gmail", exact: true })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search templates", exact: true }).fill("unknown");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No matching templates" })).toBeVisible();
    await expect(
      page.getByText("Help me create an app on Widefleet.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Reset search" }).click();
    await page.getByRole("link", { name: /^Gmail/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Gmail", exact: true })).toBeVisible();
    const response = await context.request.get("/api/v1/catalog/templates/gmail");
    const detail = z.object({ prompt: z.string() }).parse(await response.json());
    await expect(
      page.getByRole("region", { name: "Set up with your agent" }).locator("code"),
    ).toHaveText(detail.prompt);
    expect(detail.prompt).toContain("--organization 'widefleet'");
    expect(detail.prompt).toContain(`--url '${environment.configuration.PLATFORM_URL}'`);

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy setup prompt" }).click();
    await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(detail.prompt);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });

      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /dark/ : "");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`template-${width}-${colorScheme}.png`),
          fullPage: true,
        });
      }
    }

    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("Synthetic clipboard failure")) },
        configurable: true,
      }),
    );
    await page.getByRole("button", { name: /Copy setup prompt|Copied/ }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Copying is not available here. Select the text and copy it manually.",
    );

    await expect(
      page.getByRole("heading", { name: "Configure Google", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".markdown")).toContainText("GOOGLE_CLIENT_ID");
    const missing = await page.goto("/widefleet/catalog/templates/missing");
    expect(missing?.status()).toBe(404);
    const unavailable = await page.goto("/widefleet/catalog/templates/unavailable");
    expect(unavailable?.status()).toBe(503);
    await expect(page.getByRole("heading", { name: "Something went wrong." })).toBeVisible();
    expect(await environment.database.db.select({ id: apps.id }).from(apps)).toEqual(before);

    await page.goto("/widefleet/catalog/templates");
    await expect(page.getByRole("heading", { name: "Start from a template" })).toBeVisible();
    await environment.database.db
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSession.userId, person.id));
    await page.getByRole("link", { name: /^Gmail/ }).click();
    await expect(page).toHaveURL(/\/sign-in(\?|$)/);
    // Client navigation reaches the server only through the template query. Its redirect
    // cannot name the page, while a full page load passes through the request hook.
    expect(new URL(page.url()).searchParams.get("next")).toBe(null);
    expect((await context.request.get("/api/v1/catalog/templates")).status()).toBe(401);
  });
});

test(`personal connections account controls and workspace entry`, async ({ browser }) => {
  const person = environment.users.createUser({
    name: "Taylor Example",
    email: `personal@example.test`,
  });

  await environment.users.saveUser(person);
  await environment.database.db.update(organizationSettings).set({ ssoRequired: false });
  await registerAppLogin(
    environment.database.db,
    environment.configuration,
    environment.environment.PLATFORM_ENCRYPTION_KEY,
    "widefleet",
  );
  const appIds: string[] = [];
  const connected = new Set<string>();
  let unavailable = false;
  let denied = false;
  let expectedUser = person.id;
  let launches = 0;
  let statusReads = 0;
  let completion = "";

  // Stands in for the connector's origin, which completes authorization and
  // returns the browser to its completion URL.
  const connectorServer = createServer((_request, response) => {
    response.writeHead(303, { location: completion }).end();
  });

  connectorServer.listen(0, "127.0.0.1");
  await once(connectorServer, "listening");
  const connector = `http://127.0.0.1:${z.object({ port: z.number() }).parse(connectorServer.address()).port}`;

  const context = await browser.newContext({
    baseURL: environment.configuration.PLATFORM_URL,
    extraHTTPHeaders: { "x-forwarded-proto": "http" },
  });

  const signInAs = async (userId: string) => {
    expectedUser = userId;
    const login = await environment.users.login({ userId });
    await context.addCookies(
      login.cookies.map((cookie) => ({
        ...cookie,
        domain: "localhost",
        secure: false,
        sameSite: "Lax" as const,
      })),
    );
  };

  await signInAs(person.id);

  try {
    for (const [slug, displayName] of [
      ["personal-github", "GitHub"],
      ["personal-files", "Microsoft OneDrive — Finance and Operations"],
      ["personal-gmail", "Gmail"],
    ] as const) {
      const appId = crypto.randomUUID();
      const artifactId = crypto.randomUUID();
      const deploymentId = crypto.randomUUID();
      appIds.push(appId);
      await environment.database.db.insert(apps).values({
        id: appId,
        slug,
        displayName,
        hostname: `${slug}.apps.localhost`,
        ownerId: environment.owner.id,
        organizationId: "widefleet",
        state: "active",
        catalogListed: true,
      });
      await environment.database.db.insert(artifacts).values({
        id: artifactId,
        appId,
        metadata: { entrypoints: ["default", "UserConnection"] },
        modules: [],
        manifest: {},
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
        .set({ activeDeploymentId: deploymentId })
        .where(eq(apps.id, appId));
    }

    const github = z.string().parse(appIds[0]);
    const files = z.string().parse(appIds[1]);
    const gmail = z.string().parse(appIds[2]);
    connected.add(files);
    environment.authControl.userConnection((input) => {
      expect(input.identity.subject).toBe(expectedUser);

      if (denied) return new Response(null, { status: 404 });

      if (unavailable && input.appId === files) return new Response(null, { status: 503 });

      if (input.operation.action === "status") {
        statusReads++;

        return Response.json({
          setup: input.appId === gmail ? "required" : "ready",
          connection: connected.has(input.appId) ? "connected" : "disconnected",
          account: connected.has(input.appId)
            ? { id: "example-account", label: "taylor@example.test" }
            : null,
        });
      }

      if (input.operation.action === "disconnect") {
        connected.delete(input.appId);

        return Response.json({ disconnected: true });
      }

      launches++;
      connected.add(input.appId);
      completion = input.operation.completionUrl;

      // Runtime and provider redirect correctness is covered with the real loader.
      // The launch link is on another origin, as real connectors return it.
      return Response.json({
        url: `${connector}/connect/start?ticket=synthetic`,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
    });
    const page = await context.newPage();

    const invitation = await environment.database.db.transaction((transaction) =>
      prepareOrganizationInvitation(transaction, "widefleet", environment.owner.id, {
        email: person.email,
        role: "member",
      }),
    );

    await page.goto(`/invitations/${invitation.invitation.id}`);
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page).toHaveURL(environment.configuration.PLATFORM_URL + "/widefleet");
    expect(statusReads).toBe(0);

    await mkdir("../../.local/personal-connections", { recursive: true });

    for (const [name, width, height, colorScheme] of [
      ["desktop-light", 1440, 1000, "light"],
      ["desktop-dark", 1440, 1000, "dark"],
      ["mobile-dark", 390, 844, "dark"],
      ["mobile-light", 390, 844, "light"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme });
      await page.screenshot({
        path: `../../.local/personal-connections/workspace-${name}.png`,
        fullPage: true,
      });
    }

    await page.getByText("Menu", { exact: true }).click();
    await page.getByRole("link", { name: "My connections", exact: true }).click();
    await expect(page.getByRole("heading", { name: "My connections", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to apps" })).toHaveCount(0);
    await expect(page.getByText("Not connected", { exact: true })).toHaveCount(0);
    await expect(page.getByText("personal-github.apps.localhost", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Refresh", exact: true })).toHaveCount(0);
    await expect(page.getByText("taylor@example.test", { exact: false })).toBeVisible();

    await expect(page.getByText("Awaiting administrator setup")).toBeVisible();

    await mkdir("../../.local/personal-connections", { recursive: true });

    for (const [name, width, height, colorScheme] of [
      ["desktop-light", 1440, 1000, "light"],
      ["desktop-dark", 1440, 1000, "dark"],
      ["mobile-dark", 390, 844, "dark"],
      ["mobile-light", 390, 844, "light"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme });
      await page.screenshot({
        path: `../../.local/personal-connections/accounts-${name}.png`,
        fullPage: true,
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }

    const githubRow = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: "GitHub", exact: true }) });

    await githubRow.getByRole("button", { name: "Connect GitHub" }).focus();
    await page.keyboard.press("Enter");
    await expect(githubRow.getByText("taylor@example.test", { exact: false })).toBeVisible();
    expect(connected.has(github)).toBe(true);
    await expect(githubRow.getByRole("button", { name: "Reconnect GitHub" })).toBeHidden();
    const options = githubRow.getByLabel("Account options for GitHub");
    await options.focus();
    await page.keyboard.press("Enter");
    await expect(githubRow.getByRole("button", { name: "Reconnect GitHub" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(githubRow.getByRole("button", { name: "Reconnect GitHub" })).toBeHidden();
    await expect(options).toBeFocused();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "My connections", exact: true }).click();
    await expect(githubRow.getByRole("button", { name: "Reconnect GitHub" })).toBeHidden();
    await options.click();
    await page.screenshot({
      path: "../../.local/personal-connections/mobile-account-menu.png",
      fullPage: true,
    });

    await githubRow.getByRole("button", { name: "Reconnect GitHub" }).click();
    await expect.poll(() => launches).toBe(2);
    await expect(githubRow.getByText("taylor@example.test", { exact: false })).toBeVisible();
    expect(connected.has(github)).toBe(true);
    // A fresh page also verifies the native disclosure without relying on client state.
    await page.reload();
    await options.click();
    await githubRow.getByRole("link", { name: "Disconnect GitHub" }).click();
    await expect(githubRow.getByRole("button", { name: "Disconnect account" })).toBeVisible();

    await page.screenshot({
      path: "../../.local/personal-connections/mobile-disconnect.png",
      fullPage: true,
    });
    await githubRow.getByRole("link", { name: "Cancel", exact: true }).click();
    await expect(githubRow.getByRole("button", { name: "Disconnect account" })).toBeHidden();
    expect(connected.has(github)).toBe(true);
    await options.click();
    await githubRow.getByRole("link", { name: "Disconnect GitHub" }).click();
    await githubRow.getByRole("button", { name: "Disconnect account" }).click();
    await expect(githubRow.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
    expect(connected.has(files)).toBe(true);
    unavailable = true;
    await page.reload();
    await expect(page.getByText("Could not check this account.")).toBeVisible();

    await page.screenshot({
      path: "../../.local/personal-connections/mobile-unavailable.png",
      fullPage: true,
    });
    unavailable = false;
    await page.getByRole("link", { name: "Try again", exact: true }).click();
    await expect(page.getByText("Could not check this account.")).toBeHidden();
    await expect(page.getByRole("link", { name: "Try again", exact: true })).toBeHidden();
    await page.goto("/");
    await expect(page).toHaveURL(environment.configuration.PLATFORM_URL + "/widefleet");

    const other = environment.users.createUser({
      name: "Other member",
      email: `other-personal@example.test`,
    });

    await environment.users.saveUser(other);
    await environment.linkMicrosoftUser(other.id);
    await signInAs(other.id);
    await page.goto("/");
    await expect(page).toHaveURL(environment.configuration.PLATFORM_URL + "/widefleet");

    await page.getByText("Menu", { exact: true }).click();
    await page.getByRole("link", { name: "My connections", exact: true }).click();
    await expect(githubRow.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
    await signInAs(person.id);
    denied = true;
    await page.goto("/widefleet/connections");
    await expect(page.getByText("No personal connections available")).toBeVisible();
    denied = false;
    // The list shows while each connector's status is still loading.
    let releaseStatus = () => {};

    const statusHeld = new Promise<void>((resolve) => (releaseStatus = resolve));

    // Later status requests pass straight through once the first one is released.
    await page.route("**/getUserConnectionStatus?**", async (route) => {
      await statusHeld;
      await route.continue();
    });
    await page.goto("/widefleet/connections?success=true");
    await expect(githubRow.getByText("Checking account…", { exact: true })).toBeVisible();
    releaseStatus();
    await expect(githubRow.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
    // Duplicate names retain the hostnames needed to distinguish deployments.
    await environment.database.db
      .update(apps)
      .set({ displayName: "GitHub" })
      .where(eq(apps.id, gmail));
    await page.reload();
    await expect(page.getByText("personal-github.apps.localhost", { exact: true })).toBeVisible();
    await expect(page.getByText("personal-gmail.apps.localhost", { exact: true })).toBeVisible();
    // Incomplete setup remains visible when opening connection management.
    // Connectors without a web deployment are not listed.
    await environment.database.db
      .update(apps)
      .set({ webEnabled: false })
      .where(inArray(apps.id, [github, files]));
    await page.goto("/");
    await expect(page).toHaveURL(environment.configuration.PLATFORM_URL + "/widefleet");
    await page.goto("/widefleet/connections");
    await expect(page.getByText("Awaiting administrator setup")).toBeVisible();
    await environment.database.db
      .update(apps)
      .set({ webEnabled: false })
      .where(inArray(apps.id, appIds));
    await page.reload();
    await expect(page.getByText("No personal connections available")).toBeVisible();

    await page.screenshot({
      path: "../../.local/personal-connections/mobile-empty.png",
      fullPage: true,
    });
  } finally {
    environment.authControl.userConnection(undefined);
    connectorServer.close();
    await context.close();
    await environment.database.db.delete(apps).where(inArray(apps.id, appIds));
    await environment.database.db.update(organizationSettings).set({ ssoRequired: true });
  }
});

test("personal connections assert the company account as the app identity", async ({ page }) => {
  const [provider] = await environment.database.db.select().from(ssoProvider);
  const appId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();
  const identities: z.infer<typeof userConnectionInvocation>["identity"][] = [];

  await environment.database.db.update(ssoProvider).set({ domainVerified: true });
  await environment.database.db.insert(apps).values({
    id: appId,
    slug: "company-github",
    displayName: "Company GitHub",
    hostname: "company-github.apps.localhost",
    ownerId: environment.owner.id,
    organizationId: "widefleet",
    state: "active",
    catalogListed: true,
  });
  await environment.database.db.insert(artifacts).values({
    id: artifactId,
    appId,
    metadata: { entrypoints: ["default", "UserConnection"] },
    modules: [],
    manifest: {},
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
    .set({ activeDeploymentId: deploymentId })
    .where(eq(apps.id, appId));
  environment.authControl.userConnection((input) => {
    identities.push(input.identity);

    return Response.json({ setup: "ready", connection: "disconnected", account: null });
  });

  try {
    // Company sign-in to management, against the emulated Entra tenant.
    await page.goto("/sign-in");
    await page.getByLabel("Email", { exact: true }).fill("sso@example.test");
    await page.getByRole("button", { name: "Continue with email", exact: true }).click();
    await page.getByRole("button", { name: /sso@example.test/ }).click();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();

    const [signedIn] = await environment.database.db
      .select({ userId: account.userId, subject: account.accountId })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(
        and(
          eq(account.providerId, z.string().parse(provider?.providerId)),
          eq(user.email, "sso@example.test"),
        ),
      );

    // Entra accounts are keyed by object ID, the subject app sign-in issues.
    expect(z.uuid().safeParse(signedIn?.subject).success).toBe(true);

    const expected = {
      issuer: `${environment.environment.ENTRA_AUTHORITY}/${environment.environment.ENTRA_TENANT_ID}/v2.0`,
      subject: z.string().parse(signedIn?.subject),
      name: "SSO Test User",
    };

    await page.goto("/widefleet/connections");
    await expect(page.getByRole("heading", { name: "Company GitHub", exact: true })).toBeVisible();
    expect(identities.at(-1)).toEqual(expected);
  } finally {
    environment.authControl.userConnection(undefined);
    await environment.database.db.delete(apps).where(eq(apps.id, appId));
    await environment.database.db
      .update(ssoProvider)
      .set({ domainVerified: provider?.domainVerified ?? false });
  }
});
