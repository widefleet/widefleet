import type { R2Bucket } from "@cloudflare/workers-types";
import { publishedHost } from "@platform/contracts";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "./database.ts";
import { lockAppDescendants } from "./apps.ts";
import { lockOrganizationRuntime } from "./organization-runtime.ts";
import { apps, organizationRuntimes } from "./schema.ts";

export const publishOrganizationHttpAvailability = async (
  database: Database,
  storage: Pick<R2Bucket, "get" | "put">,
  organizationId: string,
  blocked: boolean,
) => {
  // Commit the pending marker before touching R2. A partial publication or a
  // lost SQL commit must remain repairable, even if the desired status changes.
  await database
    .update(organizationRuntimes)
    .set({ httpBlocked: blocked, httpAvailabilityPending: true })
    .where(
      and(
        eq(organizationRuntimes.organizationId, organizationId),
        ne(organizationRuntimes.httpBlocked, blocked),
      ),
    );

  await database.transaction(async (transaction) => {
    const execution = await lockOrganizationRuntime(transaction, organizationId);

    if (!execution.httpAvailabilityPending) return;

    // App publication and removal use the same app locks. Creation takes the
    // organization lock and new deployments inherit the desired status below.
    const inventory = await transaction
      .select({ id: apps.id, parentId: apps.parentId })
      .from(apps)
      .where(and(eq(apps.organizationId, organizationId), isNull(apps.removedAt)))
      .orderBy(apps.id);

    const ids = new Set(inventory.map((app) => app.id));

    for (const root of inventory.filter((app) => !app.parentId || !ids.has(app.parentId))) {
      const [parent] = await transaction
        .select()
        .from(apps)
        .where(and(eq(apps.id, root.id), isNull(apps.removedAt)))
        .for("update");

      if (!parent) continue;
      // Match access inheritance/removal lock order: parent before descendants.
      const targets = [parent, ...(await lockAppDescendants(transaction, parent))];

      for (const app of targets) {
        const key = `hosts/${app.hostname}.json`;
        const current = await storage.get(key);

        if (!current) continue;
        const entry = publishedHost.parse(await current.json());

        if ("deleted" in entry) continue;

        if (entry.appId !== app.id) throw new Error("Hostname belongs to another app");

        if ((entry.httpBlocked ?? false) === execution.httpBlocked) continue;

        const written = await storage.put(
          key,
          JSON.stringify({ ...entry, httpBlocked: execution.httpBlocked }),
          {
            onlyIf: { etagMatches: current.etag },
            httpMetadata: current.httpMetadata ?? {},
            customMetadata: current.customMetadata ?? {},
          },
        );

        if (!written) throw new Error("App publication changed while publishing HTTP availability");
      }
    }

    await transaction
      .update(organizationRuntimes)
      .set({ httpAvailabilityPending: false })
      .where(eq(organizationRuntimes.organizationId, organizationId));
  });
};
