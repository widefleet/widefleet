import { assetManifest } from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { appVisibility } from "./apps.ts";
import type { Database } from "./database.ts";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { apps, artifacts, deployments } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { readOnly } from "./transactions.ts";

export const iconPaths = new Map([
  ["/favicon.svg", "image/svg+xml"],
  ["/favicon.ico", "image/x-icon"],
  ["/favicon.png", "image/png"],
  ["/apple-touch-icon.png", "image/png"],
]);

export const maxIconBytes = 256 * 1024;

export const findAppIcon = (manifest: z.infer<typeof assetManifest>) => {
  for (const [path, contentType] of iconPaths) {
    const entry = manifest[path];

    if (entry && entry.size > 0 && entry.size <= maxIconBytes) return { ...entry, contentType };
  }

  return null;
};

// Icons are SVG, ICO or PNG from apps and templates: never sniffed, scripted or embedded elsewhere.
export const iconResponse = (
  icon: { bytes: Uint8Array; contentType: string },
  cacheControl: string,
) =>
  new Response(Buffer.from(icon.bytes), {
    headers: {
      "content-type": icon.contentType,
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    },
  });

// A visible app whose deployment has no icon. Its URL may cache the miss like an icon, so pages
// do not ask again for each app without one; only a new deployment changes the answer.
export const missingIconResponse = (cacheControl: string) =>
  new Response(null, { status: 404, headers: { "cache-control": cacheControl } });

// An icon URL that names the active deployment never changes; others revalidate.
export const iconCache = (requested: string | null, deploymentId: string) =>
  requested === deploymentId ? "private, max-age=31536000, immutable" : "private, no-cache";

// Read only the selected app's active artifact, never fetch an app URL or bypass its login.
// Members also see the icons of apps the catalog and My connections list for them. `find`
// selects another picture of the app, such as a screenshot, under the same rules.
export const readAppIcon = async (
  database: Database,
  storage: ArtifactStorage,
  principal: Principal,
  appId: string,
  find: (
    manifest: z.infer<typeof assetManifest>,
  ) => { hash: string; size: number; contentType: string } | null = findAppIcon,
): Promise<
  Result<
    { deploymentId: string; icon: { bytes: Uint8Array; contentType: string } | null },
    DatabaseUnavailable | InvalidOperation | StorageUnavailable
  >
> => {
  const selected = await readOnly(database, async (transaction) => {
    const [record] = await transaction
      .select({ manifest: artifacts.manifest, deploymentId: deployments.id })
      .from(apps)
      .innerJoin(
        deployments,
        and(eq(deployments.id, apps.activeDeploymentId), eq(deployments.appId, apps.id)),
      )
      .innerJoin(
        artifacts,
        and(eq(artifacts.id, deployments.artifactId), eq(artifacts.appId, apps.id)),
      )
      .where(
        and(
          eq(apps.id, appId),
          or(
            appVisibility(transaction, principal),
            and(
              isNull(apps.removedAt),
              isNull(apps.parentId),
              eq(apps.organizationId, principal.application.organizationId),
              or(
                eq(apps.catalogListed, true),
                sql`${artifacts.metadata}->'entrypoints' ? 'UserConnection'`,
              ),
            ),
          ),
          eq(apps.webEnabled, true),
          eq(apps.state, "active"),
        ),
      );

    return record
      ? Result.ok({
          deploymentId: record.deploymentId,
          icon: find(assetManifest.parse(record.manifest)),
        })
      : Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App icon not found" }));
  });

  if (selected.isErr()) return selected;
  const { deploymentId, icon } = selected.value;

  if (!icon) return Result.ok({ deploymentId, icon: null });
  const downloaded = await storage.get(`apps/${appId}/assets/${icon.hash}`);

  if (downloaded.isErr()) return downloaded;

  if (downloaded.value.byteLength !== icon.size)
    return Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App icon not found" }));

  return Result.ok({
    deploymentId,
    icon: { bytes: downloaded.value, contentType: icon.contentType },
  });
};
