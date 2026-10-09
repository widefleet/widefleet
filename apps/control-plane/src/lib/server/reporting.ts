import { createReportingSymbolicator } from "./reporting-maps.ts";
import * as contract from "@platform/contracts";
import { count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { arch, platform } from "node:os";
import { PostHog } from "posthog-node";
import { z } from "zod";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import type { Principal } from "./identity.ts";
import { InvalidOperation } from "./errors.ts";
import { agents, apps, connectors, fleets, installation } from "./schema.ts";

const projectToken = "phc_AdQ4DSNi7QHqvTVqhTGNFUNa5YxkiwLddL46KFSPvkML";

const host = "https://eu.i.posthog.com";

const component = z.enum(["control_plane", "management_ui", "agent"]);

const version = contract.reportingVersion.parse(process.env["WIDEFLEET_BUILD_VERSION"] ?? "0.0.0");

const hour = 60 * 60 * 1000;

const administrator = (principal: Principal) => {
  if (!principal.admin)
    throw new InvalidOperation({ code: "FORBIDDEN", message: "Administrator access is required" });
};

export const createReporting = (
  configuration: Configuration,
  database: Database,
  transport: typeof fetch = fetch,
  identity = async () => configuration.IDENTITY,
) => {
  const symbolicate = createReportingSymbolicator();
  let stopped = false;
  const pending = new Set<Promise<void>>();
  let observedRevision: number | undefined;
  let windowStart = Date.now();
  let errors = 0;
  const activeUsers = new Set<string>();
  const clients = new Map<string, PostHog>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const state = async () => {
    const [record] = await database
      .select()
      .from(installation)
      .where(eq(installation.id, "widefleet"));

    if (!record) throw new Error("Installation is not initialized");

    if (observedRevision !== record.reportingRevision) {
      activeUsers.clear();
      windowStart = Date.now();
      observedRevision = record.reportingRevision;
      errors = 0;
    }

    return {
      installationId: record.reportingId,
      preferences: { usage: record.usageReporting, crashes: record.crashReporting },
      effective: {
        usage: configuration.PLATFORM_USAGE_REPORTING ?? record.usageReporting,
        crashes: configuration.PLATFORM_CRASH_REPORTING ?? record.crashReporting,
      },
      managed: {
        usage: configuration.PLATFORM_USAGE_REPORTING !== undefined,
        crashes: configuration.PLATFORM_CRASH_REPORTING !== undefined,
      },
      revision: record.reportingRevision,
    };
  };

  const status = async () => {
    const current = await state();

    return {
      installationId: current.installationId,
      preferences: current.preferences,
      effective: current.effective,
      managed: current.managed,
    };
  };

  // All asynchronous reporting is bounded and isolated from the operation being observed.
  const schedule = (work: () => Promise<void>) => {
    if (stopped || pending.size >= 4) return;

    const task = work()
      .catch(() => {})
      .finally(() => {
        pending.delete(task);
      });

    pending.add(task);
  };

  const client = (category: "usage" | "crashes", revision: number) => {
    const key = `${category}:${revision}`;
    const existing = clients.get(key);

    if (existing) return existing;

    // Preference changes invalidate queued batches, including across server replicas.
    for (const [previous, sdk] of clients) {
      if (previous.startsWith(`${category}:`)) {
        clients.delete(previous);
        void sdk.shutdown(1000).catch(() => {});
      }
    }

    const sdk = new PostHog(projectToken, {
      host,
      flushAt: 20,
      maxBatchSize: 20,
      maxQueueSize: 100,
      flushInterval: 10_000,
      requestTimeout: 1500,
      fetchRetryCount: 0,
      disableGeoip: true,
      enableExceptionAutocapture: false,
      enableLocalEvaluation: false,
      disableCompression: true,
      fetch: async (url, options) => {
        const current = await state();

        if (!current.effective[category] || current.revision !== revision)
          return new Response("{}", { status: 200 });

        return transport(url, { ...options, redirect: "error" });
      },
    });

    sdk.on("error", () => {});
    clients.set(key, sdk);

    return sdk;
  };

  const common = (id: string) => ({
    distinctId: `installation:${id}`,
    properties: {
      schema_version: 1,
      scope: "installation",
      version,
      control_plane_version: version,
      control_plane_os: platform(),
      control_plane_arch: arch(),
      storage: configuration.ARTIFACT_STORAGE_PROVIDER,
      tls: configuration.TLS_MODE,
      $process_person_profile: false,
      $geoip_disable: true,
    },
  });

  const snapshot = async () => {
    const [applicationCounts] = await database
      .select({
        apps: sql<number>`count(*) filter (where ${isNull(apps.parentId)})`.mapWith(Number),
        previews: sql<number>`count(*) filter (where ${isNotNull(apps.parentId)})`.mapWith(Number),
        network_policies: sql<number>`count(*) filter (where ${apps.networkRevision} > 0)`.mapWith(
          Number,
        ),
        capability_bindings:
          sql<number>`count(*) filter (where ${apps.capabilities} <> '{}'::jsonb)`.mapWith(Number),
      })
      .from(apps);

    const [fleetCount] = await database.select({ count: count() }).from(fleets);

    const [agentCount] = await database
      .select({ count: count() })
      .from(agents)
      .where(eq(agents.enabled, true));

    const [connectorCount] = await database.select({ count: count() }).from(connectors);

    const runtimeRows = await database
      .selectDistinct({ runtime: fleets.appliedRuntime })
      .from(fleets)
      .where(isNotNull(fleets.appliedRuntime))
      .limit(21);

    const runtimeVersions: string[] = [];

    for (const row of runtimeRows.slice(0, 20)) {
      const runtime = z.object({ version: contract.reportingVersion }).safeParse(row.runtime);

      if (runtime.success) runtimeVersions.push(runtime.data.version);
    }

    const company = await identity();

    return {
      component: "control_plane",
      version,
      os: platform(),
      arch: arch(),
      storage: configuration.ARTIFACT_STORAGE_PROVIDER,
      authentication: company?.provider.type ?? "local",
      directory_lookup: company?.directory !== null && company?.directory !== undefined,
      runtime_versions: runtimeVersions,
      runtime_versions_capped: runtimeRows.length > 20,
      tls: configuration.TLS_MODE,
      app_logging: configuration.CLICKHOUSE_URL !== undefined,
      ...applicationCounts,
      fleets: fleetCount?.count ?? 0,
      agents: agentCount?.count ?? 0,
      connectors: connectorCount?.count ?? 0,
      active_management_users: activeUsers.size,
      active_management_users_capped: activeUsers.size >= 100_000,
      observation_window_ms: Date.now() - windowStart,
    };
  };

  const heartbeat = async () => {
    const current = await state();

    if (current.effective.usage) {
      const envelope = common(current.installationId);
      client("usage", current.revision).capture({
        ...envelope,
        event: "installation_snapshot",
        properties: { ...envelope.properties, ...(await snapshot()) },
      });
    }

    activeUsers.clear();
    windowStart = Date.now();
    errors = 0;
  };

  const capture = (
    report: z.infer<typeof contract.reportingError>,
    source: z.infer<typeof component>,
    release = version,
  ) => {
    const safe = contract.reportingError.parse(report);
    schedule(async () => {
      const current = await state();

      if (!current.effective.crashes || errors >= 100) return;
      errors += 1;
      const resolved = await symbolicate(safe);
      const envelope = common(current.installationId);
      client("crashes", current.revision).capture({
        ...envelope,
        event: "$exception",
        properties: {
          ...envelope.properties,
          component: source,
          version: release,
          $exception_level: "error",
          $exception_list: [
            {
              type: safe.type,
              value: `Widefleet ${source} ${safe.type}`,
              stacktrace: {
                type: "raw",
                frames: [...resolved.frames].reverse().map((frame) => ({
                  ...frame,
                  platform: "custom",
                  lang: source === "agent" ? "rust" : "javascript",
                  function: frame.function ?? "<unknown>",
                  resolved: true,
                  in_app: true,
                })),
              },
            },
          ],
        },
      });
    });
  };

  return {
    start: () => {
      if (timer || stopped) return;
      schedule(heartbeat);
      timer = setInterval(() => schedule(heartbeat), hour);
      timer.unref();
    },
    status,
    read: async (principal: Principal) => {
      administrator(principal);

      return await status();
    },
    update: async (
      principal: Principal,
      preferences: z.infer<typeof contract.reportingPreferences>,
    ) => {
      administrator(principal);
      const safe = contract.reportingPreferences.parse(preferences);
      await database
        .update(installation)
        .set({
          usageReporting:
            configuration.PLATFORM_USAGE_REPORTING === undefined
              ? safe.usage
              : installation.usageReporting,
          crashReporting:
            configuration.PLATFORM_CRASH_REPORTING === undefined
              ? safe.crashes
              : installation.crashReporting,
          reportingRevision: sql`${installation.reportingRevision} + 1`,
        })
        .where(eq(installation.id, "widefleet"));
      activeUsers.clear();

      for (const sdk of clients.values()) void sdk.flush().catch(() => {});

      return await status();
    },
    preview: async (principal: Principal) => {
      administrator(principal);
      const current = await state();
      const envelope = common(current.installationId);

      return {
        ...envelope,
        event: "installation_snapshot",
        properties: { ...envelope.properties, ...(await snapshot()) },
      };
    },
    active: (id: string) => {
      if (configuration.PLATFORM_USAGE_REPORTING === false || activeUsers.size >= 100_000) return;
      schedule(async () => {
        if ((await state()).effective.usage && activeUsers.size < 100_000) activeUsers.add(id);
      });
    },
    exception: (error: Error) => capture(contract.sanitizeReportingError(error), "control_plane"),
    browser: (report: z.infer<typeof contract.browserReporting>) =>
      capture(report.error, "management_ui", report.version),
    agent: (report: z.infer<typeof contract.agentReporting>) => {
      const safe = contract.agentReporting.parse(report);

      if (safe.error) capture(safe.error, "agent", safe.version);
      else
        schedule(async () => {
          const current = await state();

          if (!current.effective.usage) return;
          const envelope = common(current.installationId);
          client("usage", current.revision).capture({
            ...envelope,
            event: "agent_heartbeat",
            properties: {
              ...envelope.properties,
              component: "agent",
              version: safe.version,
              os: safe.os,
              arch: safe.arch,
            },
          });
        });
    },
    operation: (report: z.infer<typeof contract.reportingOperation>) => {
      const safe = contract.reportingOperation.parse(report);
      schedule(async () => {
        const current = await state();

        if (!current.effective.usage) return;
        const envelope = common(current.installationId);
        client("usage", current.revision).capture({
          ...envelope,
          event: "operation_completed",
          properties: { ...envelope.properties, component: "control_plane", ...safe },
        });
      });
    },
    flush: async () => {
      await Promise.all(pending);
      await Promise.all([...clients.values()].map((sdk) => sdk.flush().catch(() => {})));
    },
    close: async () => {
      stopped = true;
      clearInterval(timer);
      let deadline: ReturnType<typeof setTimeout> | undefined;

      const expired = new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 2000);
      });

      const drain = async () => {
        await Promise.all(pending);
        await Promise.all([...clients.values()].map((sdk) => sdk.shutdown(1500).catch(() => {})));
      };

      await Promise.race([drain(), expired]);
      clearTimeout(deadline);
    },
  };
};
