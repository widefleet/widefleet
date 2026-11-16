import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import * as contract from "@platform/contracts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import { agents, apps, appUsage, installation } from "./schema.ts";
import { readBody } from "./upload-body.ts";

const week = 7 * 24 * 60 * 60 * 1000;

export const createAppUsage = (configuration: Configuration, database: Database) => {
  const token = (organizationId: string) =>
    `usage_${createHmac("sha256", z.string().min(32).parse(configuration.BETTER_AUTH_SECRET))
      .update(`widefleet-app-usage-v1:${organizationId}`)
      .digest("hex")}`;

  const status = (row: typeof installation.$inferSelect) => ({
    enabled: configuration.PLATFORM_USAGE_REPORTING ?? row.usageReporting,
    revision: row.reportingRevision,
  });

  return {
    credentials: async (agentId: string) => {
      const [agent] = await database.select().from(agents).where(eq(agents.id, agentId));

      const [row] = await database
        .select()
        .from(installation)
        .where(eq(installation.id, "widefleet"));

      if (!agent || !row) throw new Error("Installation agent is unavailable");

      return {
        ...status(row),
        organizationId: agent.organizationId,
        token: token(agent.organizationId),
      };
    },
    ingest: async (request: Request, organizationId: string) => {
      const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

      if (
        !/^usage_[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token(organizationId)))
      )
        return new Response(null, { status: 401 });

      const bytes = await readBody(request, 32 * 1024);

      if (bytes.isErr()) return new Response(null, { status: 413 });
      let value: unknown;

      try {
        value = JSON.parse(new TextDecoder().decode(bytes.value));
      } catch {
        return new Response(null, { status: 400 });
      }

      const parsed = contract.runtimeUsage.safeParse(value);

      if (!parsed.success) return new Response(null, { status: 400 });
      const input = parsed.data;

      if (
        new Set(input.counts.map((item) => `${item.appId}:${item.weekStart}`)).size !==
        input.counts.length
      )
        return new Response(null, { status: 400 });

      const currentWeek = contract.reportingWeek();
      const previousWeek = contract.reportingWeek(Date.now() - week);

      if (
        input.counts.some((item) => item.weekStart < previousWeek || item.weekStart > currentWeek)
      )
        return new Response(null, { status: 400 });

      return database.transaction(async (transaction) => {
        // Serialize with preference changes, including on other server replicas.
        const [row] = await transaction
          .select()
          .from(installation)
          .where(eq(installation.id, "widefleet"))
          .for("share");

        if (!row) throw new Error("Installation is not initialized");
        const current = status(row);

        if (current.enabled && current.revision === input.revision && input.counts.length) {
          const available = await transaction
            .select({ id: apps.id })
            .from(apps)
            .where(
              and(
                eq(apps.organizationId, organizationId),
                inArray(
                  apps.id,
                  input.counts.map((item) => item.appId),
                ),
              ),
            );

          const ids = new Set(available.map((app) => app.id));

          const records = input.counts.flatMap((item) =>
            ids.has(item.appId) ? [{ ...item, source: input.source }] : [],
          );

          if (records.length)
            await transaction
              .insert(appUsage)
              .values(records)
              .onConflictDoUpdate({
                target: [appUsage.weekStart, appUsage.appId, appUsage.source],
                set: { invocations: sql`greatest(${appUsage.invocations}, excluded.invocations)` },
              });
        }

        return Response.json(current);
      });
    },
    snapshot: async () => {
      const weeks = [contract.reportingWeek(), contract.reportingWeek(Date.now() - week)];

      const rows = await database
        .select({
          week_start: appUsage.weekStart,
          app_invocations: sql<number>`sum(${appUsage.invocations})`.mapWith(Number),
          active_apps: sql<number>`count(distinct ${appUsage.appId})`.mapWith(Number),
        })
        .from(appUsage)
        .where(inArray(appUsage.weekStart, weeks))
        .groupBy(appUsage.weekStart);

      return weeks.map(
        (week_start) =>
          rows.find((row) => row.week_start === week_start) ?? {
            week_start,
            app_invocations: 0,
            active_apps: 0,
          },
      );
    },
    prune: () =>
      database
        .delete(appUsage)
        .where(lt(appUsage.weekStart, contract.reportingWeek(Date.now() - week))),
  };
};
