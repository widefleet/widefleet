import { and, eq, isNull, sql } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { z } from "zod";
import {
  userConnectionStatus,
  userConnectionLaunch,
  userConnectionInvocation,
  type userConnectionAction,
  type userConnectionEntry,
} from "@platform/contracts";
import { apps, artifacts, deployments } from "./schema.ts";
import { readOrganizationSlug } from "./organization.ts";
import { workspacePath } from "../workspace-path.ts";
import type { Database } from "./database.ts";
import type { Configuration } from "./config.ts";
import type { Principal } from "./identity.ts";
import type { createAppUserIdentity } from "./app-user-identity.ts";
import { InvalidOperation } from "./errors.ts";
import type { Observation } from "./observation.ts";

export type UserConnectionRequest = (
  input: z.infer<typeof userConnectionInvocation>,
  signal?: AbortSignal,
) => Promise<{ status: number; text(): Promise<string> }>;

export const createUserConnections = (
  database: Database,
  configuration: Configuration,
  identify: ReturnType<typeof createAppUserIdentity>,
  request?: UserConnectionRequest,
  reportException?: Observation["exception"],
) => {
  const candidates = (principal: Principal) =>
    database
      .select({
        appId: apps.id,
        displayName: apps.displayName,
        hostname: apps.hostname,
        activeDeploymentId: deployments.id,
      })
      .from(apps)
      .innerJoin(deployments, eq(deployments.id, apps.activeDeploymentId))
      .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
      .where(
        and(
          eq(apps.organizationId, principal.application.organizationId),
          isNull(apps.removedAt),
          isNull(apps.parentId),
          eq(apps.webEnabled, true),
          eq(apps.state, "active"),
          sql`${artifacts.metadata}->'entrypoints' ? 'UserConnection'`,
        ),
      )
      .orderBy(apps.displayName, apps.id);

  const call = async (
    principal: Principal,
    target: Awaited<ReturnType<typeof candidates>>[number],
    identity: Awaited<ReturnType<typeof identify>>,
    operation: z.infer<typeof userConnectionAction>,
    signal?: AbortSignal,
  ) => {
    if (!request)
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "Personal connections require an available app runtime",
      });

    const response = await request(
      userConnectionInvocation.parse({
        organizationId: principal.application.organizationId,
        appId: target.appId,
        hostname: target.hostname,
        identity,
        operation,
      }),
      signal,
    );

    if (response.status === 404) return null;

    if (response.status === 409)
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "App sign-in settings are still being applied. Try again.",
      });

    if (response.status !== 200)
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "This connection is temporarily unavailable. Try again.",
      });

    return z.unknown().parse(JSON.parse(await response.text()));
  };

  const target = async (principal: Principal, appId: string) => {
    const unavailable = () =>
      new InvalidOperation({
        code: "NOT_FOUND",
        message: "This personal connection is unavailable",
      });

    const record = (await candidates(principal)).find((candidate) => candidate.appId === appId);

    if (!record) throw unavailable();

    return { record, identity: await identify(principal) };
  };

  // A failed check leaves the connector listed as unavailable. A connector that no
  // longer offers personal connections is left out.
  const check = async (
    principal: Principal,
    record: Awaited<ReturnType<typeof candidates>>[number],
    identity: Awaited<ReturnType<typeof identify>>,
    deadline: AbortSignal,
  ): Promise<z.infer<typeof userConnectionEntry> | null> => {
    try {
      const result = await call(principal, record, identity, { action: "status" }, deadline);

      return result === null
        ? null
        : { ...record, status: userConnectionStatus.parse(result), unavailable: false };
    } catch (cause) {
      // Report unexpected failures by kind only: connector responses can contain provider data.
      if (!deadline.aborted)
        void reportException?.(new Error("A personal connection status check failed"), undefined, {
          appId: record.appId,
          organizationId: principal.application.organizationId,
          failure:
            cause instanceof APIError
              ? "runtime"
              : cause instanceof z.ZodError || cause instanceof SyntaxError
                ? "response"
                : "request",
        });

      return { ...record, status: null, unavailable: true };
    }
  };

  // Each check runs customer code. Bound both concurrency and the total wait; records not
  // reached before the deadline remain explicitly unavailable.
  const checkAll = async (
    principal: Principal,
    records: Awaited<ReturnType<typeof candidates>>,
  ): Promise<(z.infer<typeof userConnectionEntry> | null)[]> => {
    if (!records.length) return [];
    const identity = await identify(principal);

    const results: (z.infer<typeof userConnectionEntry> | null)[] = records.map((record) => ({
      ...record,
      status: null,
      unavailable: true,
    }));

    const deadline = AbortSignal.timeout(5_000);
    let next = 0;

    await Promise.all(
      Array.from({ length: Math.min(4, records.length) }, async () => {
        while (!deadline.aborted) {
          const index = next++;
          const record = records[index];

          if (!record) return;
          results[index] = await check(principal, record, identity, deadline);
        }
      }),
    );

    return results;
  };

  return {
    list: async (principal: Principal) =>
      (await checkAll(principal, await candidates(principal))).filter((result) => result !== null),
    // The page lists connectors right away and loads their statuses together afterwards,
    // because a status runs the connector's code.
    records: async (principal: Principal) => {
      const records = await candidates(principal);

      // A refused identity applies to every connector, so the list reports it once.
      if (records.length) await identify(principal);

      return records;
    },
    // A connector missing from the result no longer offers personal connections.
    statuses: async (principal: Principal, appIds: string[]) => {
      const records = (await candidates(principal)).filter((record) =>
        appIds.includes(record.appId),
      );

      const results = await checkAll(principal, records);

      return new Map(records.map((record, index) => [record.appId, results[index] ?? null]));
    },
    prepare: async (principal: Principal, appId: string) => {
      const { record, identity } = await target(principal, appId);

      const slug = await readOrganizationSlug(database, principal.application.organizationId);

      // The connector returns the person to the page listing their connections.
      const completion = new URL(workspacePath(slug, "/connections"), configuration.PLATFORM_URL);

      completion.searchParams.set("completed", appId);

      const result = await call(principal, record, identity, {
        action: "prepare",
        completionUrl: completion.href,
      });

      if (result === null)
        throw new InvalidOperation({
          code: "NOT_FOUND",
          message: "This personal connection is unavailable",
        });

      return userConnectionLaunch.parse(result);
    },
    disconnect: async (principal: Principal, appId: string) => {
      const { record, identity } = await target(principal, appId);

      const result = await call(principal, record, identity, {
        action: "disconnect",
      });

      if (result === null)
        throw new InvalidOperation({
          code: "NOT_FOUND",
          message: "This personal connection is unavailable",
        });

      return z.strictObject({ disconnected: z.literal(true) }).parse(result);
    },
  };
};
