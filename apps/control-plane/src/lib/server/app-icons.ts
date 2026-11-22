import { assetManifest } from "@platform/contracts";
import { Result } from "better-result";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { appVisibility } from "./apps.ts";
import type { Database } from "./database.ts";
import { DatabaseUnavailable, InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { apps, artifacts, deployments } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact } from "./transactions.ts";

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

export const readAppOrganization = (database: Database, appId: string) =>
  Result.tryPromise({
    try: async () => {
      const [record] = await database
        .select({ organizationId: apps.organizationId })
        .from(apps)
        .where(eq(apps.id, appId));

      return record?.organizationId ?? null;
    },
    catch: (cause) => new DatabaseUnavailable({ message: "Could not read the app", cause }),
  });

// Read only the selected app's active artifact, never fetch an app URL or bypass its login.
// Members also see the icons of apps the catalog and My connections list for them.
export const readAppIcon = async (
  database: Database,
  storage: ArtifactStorage,
  principal: Principal,
  appId: string,
) => {
  const selected = await transact(database, async (transaction) => {
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

    const icon = record ? findAppIcon(assetManifest.parse(record.manifest)) : null;

    return icon && record
      ? Result.ok({ ...icon, deploymentId: record.deploymentId })
      : Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App icon not found" }));
  });

  if (selected.isErr()) return selected;
  const icon = selected.value;
  const downloaded = await storage.get(`apps/${appId}/assets/${icon.hash}`);

  if (downloaded.isErr()) return downloaded;

  if (downloaded.value.byteLength !== icon.size)
    return Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App icon not found" }));

  return Result.ok({
    bytes: downloaded.value,
    contentType: icon.contentType,
    deploymentId: icon.deploymentId,
  });
};
