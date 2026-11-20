import { apps } from "./schema.ts";
import { eq } from "drizzle-orm";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { withCloudflareDatabase } from "./cloudflare-database.ts";

// MCP search reads a per-organization index that the runtime derives from the
// committed route and publication. Refresh it after either changes.
export const refreshCloudflareServiceIndex = (bindings: CloudflareBindings, appId: string) =>
  withCloudflareDatabase(bindings, async ({ db }) => {
    const runtime = bindings.APP_RUNTIME;

    if (!runtime) throw new Error("The app runtime service binding is missing");

    const [app] = await db
      .select({ organizationId: apps.organizationId, hostname: apps.hostname })
      .from(apps)
      .where(eq(apps.id, appId));

    if (!app) return;

    const response = await runtime.fetch(
      "https://runtime.internal/.well-known/widefleet/service-index",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(app),
      },
    );

    await response.body?.cancel();

    // A runtime release without the index searches without it.
    if (response.status === 404) return;

    if (!response.ok) throw new Error("The service search index could not be refreshed");
  });
