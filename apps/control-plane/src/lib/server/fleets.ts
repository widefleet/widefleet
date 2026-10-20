import type { Principal } from "./identity.ts";
import { Result } from "better-result";
import type { Database, DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import { transact } from "./transactions.ts";
import { eq } from "drizzle-orm";
import { agents, apps, fleets, jobs } from "./schema.ts";
import type { Transaction } from "./transactions.ts";

// The installation's execution target exists independently of agent credentials.
export const defaultFleet = async (transaction: DatabaseExecutor) => {
  const [fleet] = await transaction.select().from(fleets).where(eq(fleets.name, "default"));

  if (!fleet) throw new Error("The installation has no default fleet");

  return fleet;
};

export const lockFleet = async (transaction: Transaction, fleetId: string) => {
  const [fleet] = await transaction
    .select()
    .from(fleets)
    .where(eq(fleets.id, fleetId))
    .for("no key update");

  if (!fleet) throw new InvalidOperation({ code: "NOT_FOUND", message: "Fleet not found" });

  return fleet;
};

export const lockApplicationFleet = async (
  transaction: Transaction,
  context: Principal["application"],
) => {
  const fleet = await lockFleet(transaction, context.fleetId);

  if (fleet.organizationId !== context.organizationId)
    throw new InvalidOperation({ code: "NOT_FOUND", message: "Fleet not found" });

  return fleet;
};

export const requireAgentExecution = async (
  transaction: Transaction,
  fleetId: string,
  operation: string,
) => {
  const [fleet] = await transaction.select().from(fleets).where(eq(fleets.id, fleetId));

  if (fleet?.executor === "cloudflare")
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: `${operation} is not available on Cloudflare yet`,
    });
};

export const initializeCloudflareFleet = (database: Database) =>
  transact(database, async (transaction) => {
    const fleet = await lockFleet(transaction, (await defaultFleet(transaction)).id);

    if (fleet.executor === "cloudflare") return Result.ok(true);

    const [agent] = await transaction
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.fleetId, fleet.id))
      .limit(1);

    const [app] = await transaction
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.fleetId, fleet.id))
      .limit(1);

    const [job] = await transaction
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.fleetId, fleet.id))
      .limit(1);

    if (agent || app || job)
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "Initialize Cloudflare execution on an empty installation",
      });

    await transaction.update(fleets).set({ executor: "cloudflare" }).where(eq(fleets.id, fleet.id));

    return Result.ok(true);
  });
