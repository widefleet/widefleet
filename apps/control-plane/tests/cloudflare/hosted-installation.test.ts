import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import { runtimeRelease } from "@platform/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestEnvironment } from "../environment.ts";
import { initializeCloudflareRuntime } from "../../src/lib/server/organization-runtime.ts";
import { createCloudflareProvisioner } from "../../src/lib/server/cloudflare-provisioning.ts";
import {
  cloudflareRuntimeBindings,
  organizationRuntimes,
  runtimeReleases,
} from "../../src/lib/server/schema.ts";
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
  it("validates and applies execution profiles only to the parent runtime", async () => {
    const executionLimits = {
      http: { cpuMs: 100, subRequests: 50 },
      service: { cpuMs: 250, subRequests: 50 },
      cron: { cpuMs: 1000, subRequests: 200 },
      workflow: { cpuMs: 5000, subRequests: 500 },
      readiness: { cpuMs: 100, subRequests: 10 },
    };

    const configured = hostedInstallation.parse({ ...installation, executionLimits });

    const configs = await hostedConfigurations(configured, ids, "email", {
      vars: { OBSERVER_LABEL: "fixture", WIDEFLEET_EXECUTION_LIMITS: "stale-policy" },
    });

    expect(configs.runtime.vars["WIDEFLEET_EXECUTION_LIMITS"]).toBe(
      JSON.stringify(executionLimits),
    );
    expect(configs.runtime.vars["OBSERVER_LABEL"]).toBe("fixture");
    expect(configs.controlPlane.vars).not.toHaveProperty("WIDEFLEET_EXECUTION_LIMITS");
    expect(configs.initialize.vars).not.toHaveProperty("WIDEFLEET_EXECUTION_LIMITS");
    expect((await hostedConfigurations(installation, ids)).runtime.vars).not.toHaveProperty(
      "WIDEFLEET_EXECUTION_LIMITS",
    );
    expect(() => hostedInstallation.parse({ ...installation, executionLimits: {} })).toThrow();
  });

  it("configures Queue deployment admission without removing existing runtime bindings", async () => {
    expect(installation.queues).toBe(true);

    for (const queues of [true, false]) {
      const configs = await hostedConfigurations({ ...installation, queues }, ids);
      expect(configs.controlPlane.vars.WIDEFLEET_QUEUES).toBe(String(queues));
      expect(configs.runtime.unsafe.metadata.keep_bindings).toContain("queue");
      expect(configs.runtime).not.toHaveProperty("queues");
    }
  });

  it("shares the existing configuration namespace between runtime and control plane", async () => {
    const configs = await hostedConfigurations(installation, ids);
    expect(configs.controlPlane.kv_namespaces).toEqual(configs.runtime.kv_namespaces);
    expect(configs.controlPlane.kv_namespaces).toEqual([{ binding: "AUTH_CONFIG", id: ids.auth }]);
  });
  it("defaults to email and preserves explicit sign-in delivery in the deployed Worker", async () => {
    expect(
      (await hostedConfigurations(installation, ids)).controlPlane.vars.LOGIN_CODE_DELIVERY,
    ).toBe("email");

    for (const delivery of ["email", "console"] as const) {
      const configs = await hostedConfigurations(installation, ids, delivery);
      expect(configs.controlPlane.vars.LOGIN_CODE_DELIVERY).toBe(delivery);
    }
  });

  it("keeps authentication rate policies with stable, installation-specific namespaces", async () => {
    const first = (await hostedConfigurations(installation, ids)).controlPlane.ratelimits;
    const again = (await hostedConfigurations(installation, ids)).controlPlane.ratelimits;

    const other = (await hostedConfigurations({ ...installation, name: "other" }, ids)).controlPlane
      .ratelimits;

    expect(first).toEqual(again);
    expect(first?.length).toBeGreaterThan(0);
    expect(new Set(first?.map((binding) => binding.namespace_id)).size).toBe(first?.length);

    for (const binding of first ?? []) {
      expect(binding.name).toBe(`AUTH_RATE_LIMIT_${binding.simple.limit}_${binding.simple.period}`);
      expect(binding.namespace_id).toMatch(/^[1-9][0-9]*$/);
      expect(other?.some((entry) => entry.namespace_id === binding.namespace_id)).toBe(false);
    }
  });

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

  it("updates only caching through Wrangler, preserving Hyperdrive connection and TLS settings", async () => {
    const updates: unknown[] = [];

    const api = createServer((request, response) => {
      const handle = async () => {
        let body = "";

        for await (const chunk of request) body += String(chunk);

        if (
          request.method !== "PATCH" ||
          request.url !== `/accounts/${ids.account}/hyperdrive/configs/${installation.hyperdriveId}`
        )
          throw new Error(`Unexpected request: ${request.method} ${request.url}`);

        updates.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ success: true, result: { id: installation.hyperdriveId } }));
      };

      handle().catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });

    const directory = await mkdtemp(join(tmpdir(), "widefleet-hosted-hyperdrive-"));

    try {
      api.listen(0, "127.0.0.1");
      await once(api, "listening");
      const port = z.object({ port: z.number() }).parse(api.address()).port;
      const path = join(directory, "account.json");
      await writeFile(path, JSON.stringify({ account_id: ids.account }));

      const cloudflare = createCloudflareProvisioner(configuration, async (input, init) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        expect(request.method).toBe("GET");

        if (pathname.endsWith("/r2/buckets/fixture-artifacts"))
          return Response.json({ success: true, result: { name: "fixture-artifacts" } });

        if (pathname.endsWith("/storage/kv/namespaces"))
          return Response.json({
            success: true,
            result: [{ id: ids.auth, title: "fixture-auth" }],
          });

        throw new Error(`Unexpected request: ${pathname}`);
      });

      await provisionHostedResources(installation, cloudflare, async (args) => {
        await promisify(execFile)("pnpm", ["exec", "wrangler", ...args, "--config", path], {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          env: {
            ...process.env,
            CI: "true",
            CLOUDFLARE_API_TOKEN: "synthetic-hyperdrive-token",
            CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${port}`,
            WRANGLER_SEND_METRICS: "false",
          },
          timeout: 15_000,
        });
      });

      expect(updates).toEqual([{ caching: { disabled: true } }]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        api.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("composes control-plane scheduling and bindings without losing installation variables", async () => {
    const configs = await hostedConfigurations(
      installation,
      ids,
      "email",
      {},
      {
        triggers: { crons: ["* * * * *"] },
        vpc_networks: [{ binding: "EXAMPLE", tunnel_id: "00000000-0000-4000-8000-000000000001" }],
        vars: { EXTENSION_LABEL: "fixture" },
      },
    );

    expect(configs.controlPlane).toMatchObject({
      triggers: { crons: ["* * * * *"] },
      vpc_networks: [{ binding: "EXAMPLE" }],
      hyperdrive: [{ binding: "HYPERDRIVE", id: installation.hyperdriveId }],
      r2_buckets: [{ binding: "ARTIFACTS" }],
      vars: {
        EXTENSION_LABEL: "fixture",
        PLATFORM_URL: installation.platformUrl,
        APP_DOMAIN: installation.appDomain,
        LOGIN_CODE_DELIVERY: "email",
      },
    });
    expect(configs.runtime).not.toHaveProperty("triggers");
    expect(configs.runtime.vars).not.toHaveProperty("EXTENSION_LABEL");
  });

  it("bundles extra runtime variables while retaining event configuration, logging and app bindings", async () => {
    const configs = await hostedConfigurations(installation, ids, "email", {
      vars: { OBSERVER_LABEL: "installation-fixture" },
    });

    expect(configs.runtime.vars).toEqual({
      WIDEFLEET_CONFIGURATION: JSON.stringify({ source: "r2" }),
      WIDEFLEET_LOGS: "cloudflare",
      OBSERVER_LABEL: "installation-fixture",
    });
    expect(configs.controlPlane.vars).not.toHaveProperty("OBSERVER_LABEL");
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

  it.runIf(process.env["RUN_CLOUDFLARE_TESTS"] === "1")(
    "bundles the control plane with email restricted to the configured sender",
    async () => {
      const configs = await hostedConfigurations(
        { ...installation, emailFrom: "notifications@notify.example.test" },
        ids,
      );

      const directory = await mkdtemp(join(tmpdir(), "widefleet-hosted-email-"));

      try {
        const path = join(directory, "wrangler.json");
        await writeFile(path, JSON.stringify(configs.controlPlane));

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
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            env: { ...process.env, CLOUDFLARE_API_TOKEN: "", WRANGLER_SEND_METRICS: "false" },
            maxBuffer: 1024 * 1024,
          },
        );

        expect(output.stdout).toContain("--dry-run: exiting now");
        expect(configs.controlPlane.send_email).toEqual([
          { name: "EMAIL", allowed_sender_addresses: ["notifications@notify.example.test"] },
        ]);
        expect(configs.initialize.send_email).toEqual([
          {
            name: "EMAIL",
            allowed_sender_addresses: ["notifications@notify.example.test"],
            remote: true,
          },
        ]);
        expect(configs.initialize.vars["EMAIL_FROM"]).toBe("notifications@notify.example.test");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("Hosted infrastructure deployment coordination", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  const source = "export default { fetch() { return new Response('fixture'); } }";

  const release = runtimeRelease.parse({
    protocol: 3,
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
    const initialized = await initializeCloudflareRuntime(environment.database.db);

    if (initialized.isErr()) throw initialized.error;
  });
  beforeEach(async () => {
    marker = null;
    saved.clear();
    await environment.database.db.delete(cloudflareRuntimeBindings);
    await environment.database.db.delete(runtimeReleases);
    await environment.database.db
      .update(organizationRuntimes)
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
    const [execution] = await environment.database.db.select().from(organizationRuntimes);
    expect(execution?.appliedRuntime).toMatchObject({ version: release.version });
    expect(saved.size).toBe(1);
  });

  it("keeps the previous database state when deployment or verification fails", async () => {
    await expect(
      deployHostedRuntime(environment.database.db, cloudflare, storage, release, async () => {
        throw new Error("fixture deployment failed");
      }),
    ).rejects.toThrow("fixture deployment failed");
    const [execution] = await environment.database.db.select().from(organizationRuntimes);
    expect(execution?.runtime).toBeNull();
    expect(execution?.appliedRuntime).toBeNull();
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
