import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import { runtimeRelease } from "@platform/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestEnvironment } from "../environment.ts";
import { initializeCloudflareFleet } from "../../src/lib/server/fleets.ts";
import { createCloudflareProvisioner } from "../../src/lib/server/cloudflare-provisioning.ts";
import { cloudflareRuntimeBindings, fleets, runtimeReleases } from "../../src/lib/server/schema.ts";
import { CloudflareBindingUpdatePending } from "../../src/lib/server/cloudflare-binding-updates.ts";
import { deployHostedRuntime } from "../../tools/hosted-runtime.ts";
import { hostedConfigurations, hostedInstallation } from "../../tools/hosted-configuration.ts";
import { provisionHostedResources } from "../../tools/hosted-resources.ts";

const installation = hostedInstallation.parse({
  name: "fixture",
  platformUrl: "https://platform.example.test",
  appDomain: "apps.example.test",
  appZone: "example.test",
  hyperdriveId: "2".repeat(32),
});

const ids = { account: "0".repeat(32), auth: "1".repeat(32) };

const configuration = {
  accountId: ids.account,
  token: "fixture",
  runtimeName: "fixture-app-runtime",
};

describe("Hosted resource provisioning", () => {
  it("reuses resources and preserves the existing Hyperdrive origin credentials", async () => {
    const created = new Set<string>();
    const writes: string[][] = [];

    const cloudflare = createCloudflareProvisioner(configuration, async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      expect(request.method).toBe("GET");

      if (path.endsWith("/r2/buckets/fixture-artifacts"))
        return created.has("r2")
          ? Response.json({ success: true, result: { name: "fixture-artifacts" } })
          : new Response(null, { status: 404 });

      if (path.endsWith("/storage/kv/namespaces"))
        return Response.json({
          success: true,
          result: created.has("kv") ? [{ id: ids.auth, title: "fixture-auth" }] : [],
        });

      throw new Error(`Unexpected request: ${path}`);
    });

    const wrangler = async (args: string[]) => {
      writes.push(args);
      created.add(args[0] ?? "");
    };

    expect(await provisionHostedResources(installation, cloudflare, wrangler)).toEqual({
      auth: ids.auth,
    });
    expect(writes.map((args) => args.slice(0, 3))).toEqual([
      ["r2", "bucket", "create"],
      ["kv", "namespace", "create"],
      ["hyperdrive", "update", installation.hyperdriveId],
    ]);
    expect(writes[2]).toEqual([
      "hyperdrive",
      "update",
      installation.hyperdriveId,
      "--caching-disabled",
      "--sslmode",
      "verify-full",
    ]);
    const settingsUpdate = writes[2];
    writes.length = 0;
    await provisionHostedResources(installation, cloudflare, wrangler);
    expect(writes).toEqual([settingsUpdate]);
  });

  it("does not interpret a provider failure as a missing resource", async () => {
    const cloudflare = createCloudflareProvisioner(
      configuration,
      async () => new Response(null, { status: 503 }),
    );

    let writes = 0;
    await expect(
      provisionHostedResources(installation, cloudflare, async () => {
        writes++;
      }),
    ).rejects.toThrow("HTTP 503");
    expect(writes).toBe(0);
  });

  it("bundles the generated runtime configuration offline with app bindings retained", async () => {
    const configs = await hostedConfigurations(installation, ids);
    const directory = await mkdtemp(join(tmpdir(), "widefleet-hosted-config-"));
    const cwd = fileURLToPath(new URL("../../", import.meta.url));

    try {
      const path = join(directory, "wrangler.json");
      await writeFile(path, JSON.stringify(configs.runtime));

      const output = await promisify(execFile)(
        "pnpm",
        [
          "exec",
          "wrangler",
          "deploy",
          "--config",
          path,
          "--dry-run",
          "--outdir",
          join(directory, "bundle"),
        ],
        {
          cwd,
          env: { ...process.env, CLOUDFLARE_API_TOKEN: "", WRANGLER_SEND_METRICS: "false" },
          maxBuffer: 1024 * 1024,
        },
      );

      expect(output.stdout).toContain("--dry-run: exiting now");
      expect(await readFile(join(directory, "bundle/loader.js"), "utf8")).toContain(
        "RuntimeManagement",
      );
      expect(configs.runtime.unsafe.metadata.keep_bindings).toEqual(
        expect.arrayContaining([
          "secret_text",
          "d1",
          "r2_bucket",
          "kv_namespace",
          "queue",
          "service",
        ]),
      );
      expect(configs.runtime).not.toHaveProperty("triggers");
      expect(configs.runtime).not.toHaveProperty("queues");
      expect(configs.controlPlane.services).toEqual([
        {
          binding: "APP_RUNTIME",
          service: configuration.runtimeName,
          entrypoint: "RuntimeManagement",
        },
      ]);
      expect(configs.controlPlane.vars["APP_RUNTIME_NAME"]).toBe(configuration.runtimeName);
      expect(configs.controlPlane.hyperdrive).toEqual([
        { binding: "HYPERDRIVE", id: installation.hyperdriveId },
      ]);
      expect(configs.controlPlane.vars).not.toHaveProperty("DATABASE_URL");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Hosted infrastructure deployment coordination", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  const source = "export default { fetch() { return new Response('fixture'); } }";

  const release = runtimeRelease.parse({
    protocol: 1,
    auth: 1,
    workflows: 1,
    cloudflare: 1,
    celld: "0.6.2",
    version: "99.0.0",
    main: "loader.js",
    modules: [
      { name: "loader.js", source, sha256: createHash("sha256").update(source).digest("hex") },
    ],
  });

  let marker: string | null = null;

  const cloudflare = createCloudflareProvisioner(configuration, async () =>
    Response.json({
      success: true,
      result: { bindings: [], annotations: marker ? { "workers/tag": marker } : {} },
    }),
  );

  const saved = new Map<string, Uint8Array>();

  const storage = {
    put: async (key: string, bytes: Uint8Array) => {
      saved.set(key, bytes);

      return Result.ok(undefined);
    },
  };

  beforeAll(async () => {
    environment = await createTestEnvironment();
    const initialized = await initializeCloudflareFleet(environment.database.db);

    if (initialized.isErr()) throw initialized.error;
  });
  beforeEach(async () => {
    marker = null;
    saved.clear();
    await environment.database.db.delete(cloudflareRuntimeBindings);
    await environment.database.db.delete(runtimeReleases);
    await environment.database.db
      .update(fleets)
      .set({ runtime: null, appliedRuntime: null, runtimeJobId: null });
  });
  afterAll(async () => {
    await environment.close();
  });

  it("blocks unconfirmed binding changes and accepts an observed confirmation", async () => {
    const id = crypto.randomUUID();
    await environment.database.db
      .insert(cloudflareRuntimeBindings)
      .values({ scope: cloudflare.scope, pending: { id } });
    let deployments = 0;

    const deploy = () =>
      deployHostedRuntime(
        environment.database.db,
        cloudflare,
        storage,
        release,
        async (confirmedBindingTag) => {
          expect(confirmedBindingTag).toBe(id);
          deployments++;
        },
      );

    await expect(deploy()).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    expect(deployments).toBe(0);
    expect(saved.size).toBe(0);
    marker = id;
    await deploy();
    expect(deployments).toBe(1);
    const [state] = await environment.database.db.select().from(cloudflareRuntimeBindings);
    expect(state?.pending).toBeNull();
    const [fleet] = await environment.database.db.select().from(fleets);
    expect(fleet?.appliedRuntime).toMatchObject({ version: release.version });
    expect(saved.size).toBe(1);
  });

  it("keeps the previous database state when deployment or verification fails", async () => {
    await expect(
      deployHostedRuntime(environment.database.db, cloudflare, storage, release, async () => {
        throw new Error("fixture deployment failed");
      }),
    ).rejects.toThrow("fixture deployment failed");
    const [fleet] = await environment.database.db.select().from(fleets);
    expect(fleet?.runtime).toBeNull();
    expect(fleet?.appliedRuntime).toBeNull();
    expect(await environment.database.db.select().from(runtimeReleases)).toHaveLength(0);
  });

  it("holds the existing binding lock until runtime deployment finishes", async () => {
    let start = () => {};

    let finish = () => {};

    const started = new Promise<void>((resolve) => {
      start = resolve;
    });

    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const deployment = deployHostedRuntime(
      environment.database.db,
      cloudflare,
      storage,
      release,
      async () => {
        start();
        await finished;
      },
    );

    await started;

    const update = environment.database.db.transaction(async (transaction) => {
      await transaction
        .insert(cloudflareRuntimeBindings)
        .values({ scope: cloudflare.scope })
        .onConflictDoNothing();
      await transaction
        .select()
        .from(cloudflareRuntimeBindings)
        .where(eq(cloudflareRuntimeBindings.scope, cloudflare.scope))
        .for("update");
    });

    try {
      await expect
        .poll(async () => {
          const result = await environment.database.db.execute(
            sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
          );

          return result.rows.length;
        })
        .toBeGreaterThan(0);
    } finally {
      finish();
      await Promise.all([deployment, update]);
    }
  });
});
