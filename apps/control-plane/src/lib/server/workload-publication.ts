import { sql } from "drizzle-orm";
import { workloadConfiguration, workloadControlPath } from "@platform/app-runtime/workload";
import { organizationRuntimes } from "./schema.ts";
import { installationOrganizationId } from "../organization.ts";
import type { Database } from "./database.ts";
import type { Configuration } from "./config.ts";
import type { RuntimeExtension } from "./runtime-extension.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";

// Publish a complete admission snapshot. Missing admission fails closed in the
// runtime; an existing snapshot survives control-plane outages without a lease.
export const publishWorkloadAdmission = (
  database: Database,
  configuration: Configuration,
  extension: Pick<RuntimeExtension, "organizationAccess" | "createOrganization">,
  publish: (body: string) => Promise<void>,
) =>
  database.transaction(async (transaction) => {
    // Concurrent schedulers must not publish an older read after a newer snapshot.
    await transaction.execute(sql`select pg_advisory_xact_lock(1740031222)`);

    const candidates = await transaction
      .select({
        id: organizationRuntimes.organizationId,
        blocked: organizationRuntimes.httpBlocked,
      })
      .from(organizationRuntimes);

    const allowed = new Set(
      extension.organizationAccess
        ? await extension.organizationAccess.filterOrganizations(candidates)
        : extension.createOrganization
          ? candidates.map(({ id }) => id)
          : [installationOrganizationId],
    );

    const port = configuration.APP_HTTPS_PORT === 443 ? "" : `:${configuration.APP_HTTPS_PORT}`;

    const snapshot = workloadConfiguration.parse({
      issuer: `https://auth.${configuration.APP_DOMAIN}${port}/workload`,
      organizations: candidates
        .filter(({ id, blocked }) => allowed.has(id) && !blocked)
        .map(({ id }) => id)
        .sort(),
    });

    await publish(JSON.stringify(snapshot));
  });

export const publishHostedWorkloadAdmission = (
  bindings: CloudflareBindings,
  database: Database,
  configuration: Configuration,
  extension: Pick<RuntimeExtension, "organizationAccess" | "createOrganization">,
) =>
  publishWorkloadAdmission(database, configuration, extension, async (body) => {
    if (!bindings.APP_RUNTIME) throw new Error("App runtime management binding is missing");

    const response = await bindings.APP_RUNTIME.fetch(
      `https://runtime.internal${workloadControlPath}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      },
    );

    await response.body?.cancel();

    if (!response.ok)
      throw new Error(`Workload configuration publication failed (${response.status})`);
  });
