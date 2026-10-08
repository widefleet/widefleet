import { installationSettings } from "@platform/contracts";
import { eq } from "drizzle-orm";
import type { Configuration } from "./config.ts";
import { authBundleIssuer, readActiveAuthBundle } from "./auth-bundle.ts";
import { providerIssuer } from "./company-identity.ts";
import { InvalidOperation } from "./errors.ts";
import { installationId } from "./installation-store.ts";
import { installation } from "./schema.ts";
import type { Transaction } from "./transactions.ts";

// Settings saves and activation reconciliation take an exclusive lock first.
// Policy writers use the same lock order and wait for the running SSO issuer.
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

  const active = await readActiveAuthBundle(configuration);

  if (active && authBundleIssuer(active) !== issuer)
    throw new InvalidOperation({
      code: "CONFLICT",
      message:
        "The replacement company sign-in service must activate before changing app permissions.",
    });
};
