import { expect, test, type Browser } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { workerMetadata } from "@platform/contracts";
import { member, organization, session } from "../../src/lib/server/auth-schema.ts";
import {
  apps,
  fleets,
  connectors,
  artifacts,
  deployments,
  jobs,
} from "../../src/lib/server/schema.ts";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { connectorFixture, connectorFiles } from "../cloudflare-connector.fixture.ts";
import { connectorReference } from "../../src/lib/server/connector-package.ts";
import { decryptSecret } from "../../src/lib/server/secret-encryption.ts";
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
  test(`manages connectors named new, preserves multiline secrets and rejects stale changes (JavaScript ${javaScriptEnabled})`, async ({
    browser,
  }) => {
    const { person, alpha, beta, context } = await organizationSession(browser, javaScriptEnabled);
    const release = connectorFixture("new");

    try {
      const page = await context.newPage();

      for (const [id, label] of [
        [alpha, "Alpha"],
        [beta, "Beta"],
      ] as const) {
        await page.goto("/organizations");
        await page.getByRole("button", { name: new RegExp(`^${label} admin$`, "i") }).click();
        await page.goto("/connectors");
        await page.getByRole("link", { name: "Deploy connector", exact: true }).click();
        await page.getByLabel("Connector name", { exact: true }).fill(release.name);
        await page.getByLabel("Upload metadata", { exact: true }).setInputFiles({
          name: "metadata.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(release.metadata)),
        });
        await page.getByLabel("Bundled modules", { exact: true }).setInputFiles(
          connectorFiles(release).map((file) => ({
            name: file.name,
            mimeType: "application/javascript",
            buffer: Buffer.from(file.bytes),
          })),
        );
        await expect(page.getByLabel("Connector name", { exact: true })).toHaveValue(release.name);
        await page.getByRole("button", { name: "Deploy connector", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/connectors/${release.name}\\?submitted=1$`));
        await expect(page.getByText("No version is active yet.")).toBeVisible();
        await page.getByRole("link", { name: "Deploy update", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Deploy connector" })).toBeVisible();
        await expect(page.getByLabel("Connector name", { exact: true })).toHaveValue(release.name);

        if (javaScriptEnabled) {
          await page.getByRole("link", { name: "All connectors", exact: true }).click();
          await page.getByRole("button", { name: /^new / }).click();
          await page.getByRole("link", { name: "Manage connector", exact: true }).click();
        } else {
          await page.goto(`/connectors/${release.name}`);
        }

        await expect(page.getByRole("heading", { name: release.name, exact: true })).toBeVisible();
        await page.getByLabel("Secret name", { exact: true }).fill("WIDEFLEET_DENIED");
        await page.getByLabel("Secret value", { exact: true }).fill("redacted-test-secret");

        const rejected = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" && response.url().includes("setConnectorSecret"),
        );

        await page.getByRole("button", { name: "Save secret", exact: true }).click();
        expect(await (await rejected).text()).not.toContain("redacted-test-secret");
        await expect(
          page.getByText("Reserved connector secret name", { exact: true }),
        ).toBeVisible();
        await page.getByLabel("Secret name", { exact: true }).fill("API_KEY");
        await page
          .getByLabel("Secret value", { exact: true })
          .fill(`first-line\n\nsecret-${id}\n  final-line  \n`);
        await page.getByRole("button", { name: "Save secret", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Remove API_KEY", exact: true }),
        ).toBeVisible();
        await expect(page.getByLabel("Secret value", { exact: true })).toHaveValue("");
        expect(await page.content()).not.toContain(`secret-${id}`);
      }

      const records = await environment.database.db
        .select({ connector: connectors, organizationId: fleets.organizationId })
        .from(connectors)
        .innerJoin(fleets, eq(connectors.fleetId, fleets.id))
        .where(eq(connectors.name, release.name));

      for (const id of [alpha, beta]) {
        const record = records.find((row) => row.organizationId === id);

        if (!record) throw new Error("Missing browser connector");
        const reference = connectorReference.parse(record.connector.package);
        // Native HTML forms normalize textarea line endings to CRLF.
        expect(
          (
            await decryptSecret(
              environment.environment.PLATFORM_ENCRYPTION_KEY,
              reference.secrets["API_KEY"] ?? "",
            )
          ).replaceAll("\r\n", "\n"),
        ).toBe(`first-line\n\nsecret-${id}\n  final-line  \n`);
      }

      const record = records.find((row) => row.organizationId === alpha);

      if (!record) throw new Error("Missing first connector");
      // Simulate the native agent's successful activation; real Cloudflare activation
      // is covered by the workerd suite.
      await environment.database.db
        .update(connectors)
        .set({ appliedPackage: record.connector.package })
        .where(
          and(eq(connectors.fleetId, record.connector.fleetId), eq(connectors.name, release.name)),
        );
      const appId = crypto.randomUUID();
      await environment.database.db.insert(apps).values({
        id: appId,
        fleetId: record.connector.fleetId,
        ownerId: person.id,
        slug: "connector-browser",
        displayName: "Connector browser",
        hostname: `connector-browser.${alpha}.example.test`,
      });
      await page.goto("/organizations");
      await page.getByRole("button", { name: /^Alpha admin$/i }).click();
      await page.goto(`/connectors?app=${appId}`);
      await page.getByLabel("Connector", { exact: true }).selectOption(release.name);
      await page.getByLabel("Entrypoint", { exact: true }).fill("Reader");
      await page.getByLabel("Binding name", { exact: true }).fill("ERP");
      await page.getByRole("button", { name: "Save connection", exact: true }).click();
      await expect(page.getByRole("button", { name: "Disconnect ERP", exact: true })).toBeVisible();
      expect(
        (await environment.database.db.select().from(apps).where(eq(apps.id, appId)))[0]
          ?.capabilities,
      ).toEqual({ ERP: { connector: release.name, entrypoint: "Reader" } });
      await page.getByRole("button", { name: "Disconnect ERP", exact: true }).click();
      await expect(page.getByRole("button", { name: "Disconnect ERP", exact: true })).toHaveCount(
        0,
      );
      await page.goto(`/connectors/${release.name}`);
      await page.getByRole("button", { name: "Remove API_KEY", exact: true }).click();
      await expect(page.getByText("No secrets configured.")).toBeVisible();
      await page.getByLabel("Secret name", { exact: true }).fill("STALE");
      await page.getByLabel("Secret value", { exact: true }).fill("stale-secret");
      const second = await context.newPage();
      await second.goto("/organizations");
      await second.getByRole("button", { name: /^Beta admin$/i }).click();
      await page.getByRole("button", { name: "Save secret", exact: true }).click();
      await expect(
        page.getByText(
          "Your organization selection changed. Reload this page before making changes.",
        ),
      ).toBeVisible();

      const unchanged = await environment.database.db
        .select()
        .from(connectors)
        .where(eq(connectors.name, release.name));

      for (const item of unchanged)
        expect(connectorReference.parse(item.package).secrets).not.toHaveProperty("STALE");
      await environment.database.db
        .update(member)
        .set({ role: "member" })
        .where(and(eq(member.userId, person.id), eq(member.organizationId, beta)));

      for (const path of [
        "/connectors/-/deploy",
        `/connectors/${release.name}`,
        `/connectors/${release.name}/logs`,
      ])
        expect((await second.goto(path))?.status()).toBe(403);
      await second.goto("/connectors");
      await expect(second.getByRole("link", { name: "Deploy connector", exact: true })).toHaveCount(
        0,
      );
      await expect(second.getByRole("link", { name: "Manage connector", exact: true })).toHaveCount(
        0,
      );
    } finally {
      await context.close();
    }
  });

  test(`retries a failed connector removal until activation succeeds (JavaScript ${javaScriptEnabled})`, async ({
    browser,
  }) => {
    const { person, alpha, context } = await organizationSession(browser, javaScriptEnabled);

    try {
      const [fleet] = await environment.database.db
        .select()
        .from(fleets)
        .where(eq(fleets.organizationId, alpha));

      if (!fleet) throw new Error("Missing organization fixture fleet");
      const appId = crypto.randomUUID();
      const artifactId = crypto.randomUUID();
      const deploymentId = crypto.randomUUID();
      const applied = { revision: 1, grants: { ERP: { connector: "erp", entrypoint: "Reader" } } };
      // A failed removal leaves the old serving snapshot in place.
      await environment.database.db.insert(apps).values({
        id: appId,
        fleetId: fleet.id,
        ownerId: person.id,
        slug: "retry-removal",
        displayName: "Retry removal",
        hostname: `retry-removal.${alpha}.example.test`,
        state: "active",
        activeDeploymentId: deploymentId,
        capabilities: {},
        capabilityRevision: 2,
        capabilityError: "Synthetic removal failure",
        appliedCapabilities: applied,
        appliedCapabilityRevision: 1,
      });
      await environment.database.db.insert(artifacts).values({
        id: artifactId,
        appId,
        manifest: {},
        modules: [],
        metadata: workerMetadata.parse({
          main_module: "worker.js",
          compatibility_date: "2026-10-01",
          bindings: [],
          assets: { upload_session: crypto.randomUUID(), binding: "ASSETS" },
        }),
      });
      await environment.database.db.insert(deployments).values({
        id: deploymentId,
        appId,
        artifactId,
        requestId: crypto.randomUUID(),
        status: "succeeded",
      });
      const page = await context.newPage();
      await page.goto("/organizations");
      await page.getByRole("button", { name: /^Alpha admin$/i }).click();
      await page.goto(`/connectors?app=${appId}`);
      await expect(page.getByText("Removal failed", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Retry removal ERP", exact: true }).click();
      await expect(page.getByText("Removal pending", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Removing ERP…", exact: true })).toBeDisabled();
      const [retried] = await environment.database.db.select().from(apps).where(eq(apps.id, appId));
      expect(retried).toMatchObject({
        capabilities: {},
        capabilityRevision: 2,
        capabilityError: null,
        appliedCapabilities: applied,
        appliedCapabilityRevision: 1,
      });
      const queued = await environment.database.db.select().from(jobs).where(eq(jobs.appId, appId));
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ fleetId: fleet.id, kind: "configure", state: "queued" });

      // Simulate the agent confirming the removal.
      await environment.database.db
        .update(apps)
        .set({ appliedCapabilityRevision: 2, appliedCapabilities: { revision: 2, grants: {} } })
        .where(eq(apps.id, appId));
      await environment.database.db
        .update(jobs)
        .set({ state: "succeeded" })
        .where(eq(jobs.appId, appId));
      await page.reload();
      await expect(page.getByText("Removal pending", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /ERP/ })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

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
      await expect(
        page.getByText(`${slug}-${alpha}.apps.localhost`, { exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Create preview", exact: true }).click();
      await page.getByLabel("App name", { exact: true }).fill("Review");
      await page.getByLabel("URL slug").fill(`${slug}-review`);
      await page.getByRole("button", { name: "Create app", exact: true }).click();
      await expect(page).toHaveURL(/\/apps\/[a-f0-9-]+$/);
      await expect(
        page.getByText(`${slug}-review-${alpha}.apps.localhost`, { exact: true }),
      ).toBeVisible();
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
          hostname: `linked-app-${alpha}.apps.localhost`,
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
