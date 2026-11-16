import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { reportingWeek } from "@platform/contracts";
import { createReporting } from "../src/lib/server/reporting.ts";
import { agents, apps, appUsage } from "../src/lib/server/schema.ts";
import { createTestEnvironment } from "./environment.ts";

describe("Weekly app usage stays local until aggregated", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  let reporter: ReturnType<typeof createReporting>;
  let credentials: Awaited<ReturnType<typeof reporter.appUsage.credentials>>;
  const app = crypto.randomUUID();
  const preview = crypto.randomUUID();
  const other = crypto.randomUUID();
  const source = crypto.randomUUID();
  const weekStart = reportingWeek();
  const previousWeek = reportingWeek(Date.now() - 7 * 86400_000);

  const events: {
    event: string;
    distinct_id: string;
    properties: Record<string, z.infer<ReturnType<typeof z.json>>>;
  }[] = [];

  const owner = {
    id: "synthetic-owner",
    name: "Private Owner",
    email: "owner@example.test",
    role: "owner" as const,
    admin: true,
    creator: true,
    application: { organizationId: "widefleet", admin: true },
  };

  const send = (
    counts: { appId: string; weekStart: string; invocations: number }[],
    options: { source?: string; revision?: number; token?: string; organization?: string } = {},
  ) =>
    reporter.appUsage.ingest(
      new Request("https://installation.example.test/api/v1/reporting/runtime/widefleet", {
        method: "POST",
        headers: { authorization: `Bearer ${options.token ?? credentials.token}` },
        body: JSON.stringify({
          source: options.source ?? source,
          revision: options.revision ?? credentials.revision,
          counts,
        }),
      }),
      options.organization ?? "widefleet",
    );

  beforeAll(async () => {
    environment = await createTestEnvironment();
    reporter = createReporting(
      {
        ...environment.configuration,
        PLATFORM_USAGE_REPORTING: undefined,
        PLATFORM_CRASH_REPORTING: false,
      },
      environment.database.db,
      async (_url, init) => {
        events.push(
          ...z
            .object({
              batch: z.array(
                z.object({
                  event: z.string(),
                  distinct_id: z.string(),
                  properties: z.record(z.string(), z.json()),
                }),
              ),
            })
            .parse(await new Request("https://eu.i.posthog.com/batch/", init).json()).batch,
        );

        return Response.json({ status: 1 });
      },
    );
    const agent = crypto.randomUUID();
    await environment.database.db
      .insert(agents)
      .values({ id: agent, organizationId: "widefleet", name: "fixture", tokenHash: agent });
    await environment.database.db.insert(apps).values(
      [app, preview].map((id) => ({
        id,
        organizationId: "widefleet",
        slug: id,
        displayName: "Private app",
        ownerId: "private-owner",
        hostname: `${id}.private.test`,
        parentId: id === preview ? app : null,
      })),
    );
    credentials = await reporter.appUsage.credentials(agent);
  });

  afterAll(async () => {
    await reporter?.close();
    await environment?.close();
  });

  it("merges replicas, retries and out-of-order counters while deduplicating active apps and previews", async () => {
    expect(
      (
        await send([
          { appId: app, weekStart, invocations: 5 },
          { appId: preview, weekStart, invocations: 3 },
        ])
      ).status,
    ).toBe(200);
    await Promise.all(
      [5, 2, 7, 6].map((invocations) => send([{ appId: app, weekStart, invocations }])),
    );
    await send([{ appId: app, weekStart, invocations: 4 }], { source: crypto.randomUUID() });
    await send([{ appId: preview, weekStart: previousWeek, invocations: 9 }]);
    expect(await reporter.appUsage.snapshot()).toEqual([
      { week_start: weekStart, app_invocations: 14, active_apps: 2 },
      { week_start: previousWeek, app_invocations: 9, active_apps: 1 },
    ]);
    // Removal of an active preview must not rewrite historical usage.
    await environment.database.db
      .update(apps)
      .set({ removedAt: new Date() })
      .where(eq(apps.id, preview));
    expect((await reporter.appUsage.snapshot())[0]?.active_apps).toBe(2);
  });

  it("rejects unauthorized and malformed inputs and ignores apps outside the credential's organization", async () => {
    const counts = [{ appId: app, weekStart, invocations: 100 }];
    expect((await send(counts, { token: `usage_${"0".repeat(64)}` })).status).toBe(401);
    expect((await send(counts, { organization: "another-organization" })).status).toBe(401);
    expect((await send([...counts, ...counts])).status).toBe(400);
    expect((await send([{ appId: app, weekStart: "2026-01-05", invocations: 1 }])).status).toBe(
      400,
    );
    await send([{ appId: other, weekStart, invocations: 100 }]);
    expect((await reporter.appUsage.snapshot())[0]?.app_invocations).toBe(14);
  });

  it("persists counts across reporter restarts and exports only installation-level weekly totals", async () => {
    reporter.start();
    await reporter.flush();
    const usage = events.filter((event) => event.event === "installation_app_usage");
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      distinct_id: `installation:${(await reporter.status()).installationId}`,
      properties: { week_start: weekStart, app_invocations: 14, active_apps: 2 },
    });
    const serialized = JSON.stringify(usage);

    for (const secret of [app, preview, source, "private", "Private", credentials.token])
      expect(serialized).not.toContain(secret);
    const restarted = createReporting(environment.configuration, environment.database.db);
    expect((await restarted.appUsage.snapshot())[0]?.app_invocations).toBe(14);
    await restarted.close();
  });

  it("honors opt-out and rejects buffered reports from a previous preference revision", async () => {
    await reporter.update(owner, { usage: false, crashes: false });
    const counts = [{ appId: app, weekStart, invocations: 100 }];
    const disabled = await send(counts);
    expect(await disabled.json()).toMatchObject({ enabled: false });
    await reporter.update(owner, { usage: true, crashes: false });
    await send(counts);
    expect((await reporter.appUsage.snapshot())[0]?.app_invocations).toBe(14);
    const updated = z.object({ revision: z.number() }).parse(await (await send([])).json());
    await send([{ appId: app, weekStart, invocations: 2 }], {
      revision: updated.revision,
      source: crypto.randomUUID(),
    });
    expect((await reporter.appUsage.snapshot())[0]?.app_invocations).toBe(16);
    const managed = createReporting(environment.configuration, environment.database.db);
    await managed.appUsage.ingest(
      new Request("https://installation.example.test", {
        method: "POST",
        headers: { authorization: `Bearer ${credentials.token}` },
        body: JSON.stringify({ source: crypto.randomUUID(), revision: updated.revision, counts }),
      }),
      "widefleet",
    );
    expect((await managed.appUsage.snapshot())[0]?.app_invocations).toBe(16);
    await managed.close();
  });

  it("bounds stored history while retaining the previous week for its final report", async () => {
    await environment.database.db
      .insert(appUsage)
      .values({ source, appId: app, weekStart: "2026-01-05", invocations: 1 });
    await reporter.appUsage.prune();
    const rows = await environment.database.db.select().from(appUsage);
    expect(rows.some((row) => row.weekStart === "2026-01-05")).toBe(false);
    expect(rows.some((row) => row.weekStart === previousWeek)).toBe(true);
  });
});
