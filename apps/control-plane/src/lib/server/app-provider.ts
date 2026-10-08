import { installationSettings } from "@platform/contracts";
import { eq } from "drizzle-orm";
import type { Configuration } from "./config.ts";
import { providerIssuer } from "./company-identity.ts";
import { InvalidOperation } from "./errors.ts";
import { installationId } from "./installation-store.ts";
import { installation } from "./schema.ts";
import type { Transaction } from "./transactions.ts";

// Settings replacement takes an exclusive lock before reconciling app policies.
// Policy writers hold a shared lock first, so an older request cannot recreate
// an old-issuer policy after that reconciliation has committed.
export const lockAppProvider = async (transaction: Transaction, configuration: Configuration) => {
  const [row] = await transaction
    .select({ settings: installation.settings })
    .from(installation)
    .where(eq(installation.id, installationId))
    .for("share");

  if (!row) throw new Error("The installation has not been initialized");
  const current = installationSettings.parse(row.settings).identity;
  const issuer = current ? providerIssuer(current.provider) : "";
  const expected = configuration.IDENTITY ? providerIssuer(configuration.IDENTITY.provider) : "";

  if (issuer !== expected)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "Company sign-in settings have changed. Reload before saving again.",
    });
};
