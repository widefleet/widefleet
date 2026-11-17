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
import type { Database } from "./database.ts";
import type { Configuration } from "./config.ts";
import type { Principal } from "./identity.ts";
import type { createAppUserIdentity } from "./app-user-identity.ts";
import { InvalidOperation } from "./errors.ts";

export type UserConnectionRequest = (
  input: z.infer<typeof userConnectionInvocation>,
) => Promise<{ status: number; text(): Promise<string> }>;

export const createUserConnections = (
  database: Database,
  configuration: Configuration,
  identify: ReturnType<typeof createAppUserIdentity>,
  request?: UserConnectionRequest,
) => {
  const candidates = (principal: Principal) =>
    database
      .select({ appId: apps.id, displayName: apps.displayName, hostname: apps.hostname })
      .from(apps)
      .innerJoin(deployments, eq(deployments.id, apps.activeDeploymentId))
      .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
      .where(
        and(
          eq(apps.organizationId, principal.application.organizationId),
          isNull(apps.removedAt),
          isNull(apps.parentId),
          eq(apps.catalogListed, true),
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
        ...identity,
        operation,
      }),
    );

    if (response.status === 404) return null;

    if (response.status === 409)
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "Company sign-in settings are still being applied. Try again.",
      });

    if (response.status !== 200)
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "This connection is temporarily unavailable. Try again.",
      });

    return z.unknown().parse(JSON.parse(await response.text()));
  };

  const target = async (principal: Principal, appId: string) => {
    const record = (await candidates(principal)).find((candidate) => candidate.appId === appId);

    if (!record)
      throw new InvalidOperation({
        code: "NOT_FOUND",
        message: "This personal connection is unavailable",
      });

    return record;
  };

  return {
    hasCandidates: async (principal: Principal) => (await candidates(principal)).length > 0,
    list: async (principal: Principal) => {
      const records = await candidates(principal);

      if (!records.length) return [];
      const identity = await identify(principal);
      const results: z.infer<typeof userConnectionEntry>[] = [];

      // Bound fan-out: each status request can execute customer code.
      for (const record of records) {
        try {
          const result = await call(principal, record, identity, { action: "status" });

          if (result !== null)
            results.push({
              ...record,
              status: userConnectionStatus.parse(result),
              unavailable: false,
            });
        } catch {
          results.push({ ...record, status: null, unavailable: true });
        }
      }

      return results;
    },
    prepare: async (principal: Principal, appId: string, onboarding = false) => {
      const record = await target(principal, appId);
      const completion = new URL("/connections", configuration.PLATFORM_URL);
      completion.searchParams.set("completed", appId);

      if (onboarding) completion.searchParams.set("onboarding", "1");

      const result = await call(principal, record, await identify(principal), {
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
      const record = await target(principal, appId);

      const result = await call(principal, record, await identify(principal), {
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
