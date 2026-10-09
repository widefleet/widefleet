import { eq } from "drizzle-orm";
import { fleets } from "./schema.ts";
import type { Transaction } from "./transactions.ts";

// The installation's execution target exists independently of agent credentials.
export const defaultFleet = async (transaction: Transaction) => {
  const [fleet] = await transaction.select().from(fleets).where(eq(fleets.name, "default"));

  if (!fleet) throw new Error("The installation has no default fleet");

  return fleet;
};
