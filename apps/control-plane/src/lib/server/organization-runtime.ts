import { installationOrganizationId } from "../organization.ts";
import { Result } from "better-result";
import type { Database, DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import { transact } from "./transactions.ts";
import { eq } from "drizzle-orm";
import { agents, apps, organizationRuntimes, jobs } from "./schema.ts";
import type { Transaction } from "./transactions.ts";

// The installation's execution target exists independently of agent credentials.
export const installationRuntime = async (transaction: DatabaseExecutor) => {
  const [execution] = await transaction
    .select()
    .from(organizationRuntimes)
    .where(eq(organizationRuntimes.organizationId, installationOrganizationId));

  if (!execution) throw new Error("The installation has no runtime configuration");

  return execution;
};

export const lockOrganizationRuntime = async (transaction: Transaction, organizationId: string) => {
  const [execution] = await transaction
    .select()
    .from(organizationRuntimes)
    .where(eq(organizationRuntimes.organizationId, organizationId))
    .for("no key update");

  if (!execution)
    throw new InvalidOperation({ code: "NOT_FOUND", message: "Organization runtime not found" });

  return execution;
};

export const requireAgentExecution = async (
  transaction: Transaction,
  organizationId: string,
  operation: string,
) => {
  const [execution] = await transaction
    .select()
    .from(organizationRuntimes)
    .where(eq(organizationRuntimes.organizationId, organizationId));

  if (!execution)
    throw new InvalidOperation({ code: "NOT_FOUND", message: "Organization runtime not found" });

  if (execution.executor === "cloudflare")
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: `${operation} is not available on Cloudflare yet`,
    });
};

export const initializeCloudflareRuntime = (database: Database) =>
  transact(database, async (transaction) => {
    const execution = await lockOrganizationRuntime(transaction, installationOrganizationId);

    if (execution.executor === "cloudflare") return Result.ok(true);

    const [agent] = await transaction
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.organizationId, execution.organizationId))
      .limit(1);

    const [app] = await transaction
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.organizationId, execution.organizationId))
      .limit(1);

    const [job] = await transaction
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.organizationId, execution.organizationId))
      .limit(1);

    if (agent || app || job)
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "Initialize Cloudflare execution on an empty installation",
      });

    await transaction
      .update(organizationRuntimes)
      .set({ executor: "cloudflare" })
      .where(eq(organizationRuntimes.organizationId, execution.organizationId));

    return Result.ok(true);
  });
