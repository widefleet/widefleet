import { assetManifest } from "@platform/contracts";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { appVisibility } from "./apps.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { apps, artifacts, deployments } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";
import { transact } from "./transactions.ts";

const iconTypes = new Map([
  ["svg", "image/svg+xml"],
  ["ico", "image/x-icon"],
  ["png", "image/png"],
]);

const preferredPaths = ["/favicon.svg", "/favicon.ico", "/favicon.png", "/apple-touch-icon.png"];

const maxIconBytes = 256 * 1024;

export const findAppIcon = (manifest: z.infer<typeof assetManifest>) => {
  const entries = Object.entries(manifest);

  const priority = (path: string) => {
    const index = preferredPaths.indexOf(path);

    return index < 0 ? preferredPaths.length : index;
  };

  entries.sort(([left], [right]) => priority(left) - priority(right) || left.localeCompare(right));

  for (const [path, entry] of entries) {
    if (!preferredPaths.includes(path) && !/\/favicon(?:[.-][\w-]+)?\.(svg|ico|png)$/.test(path))
      continue;
    const contentType = iconTypes.get(path.split(".").at(-1) ?? "");

    if (contentType && entry.size > 0 && entry.size <= maxIconBytes)
      return { ...entry, contentType };
  }

  return null;
};

// Read only the selected app's active artifact, never fetch an app URL or bypass its login.
export const readAppIcon = async (
  database: Database,
  storage: ArtifactStorage,
  principal: Principal,
  appId: string,
) => {
  const selected = await transact(database, async (transaction) => {
    const [record] = await transaction
      .select({ manifest: artifacts.manifest })
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
          appVisibility(transaction, principal),
          eq(apps.webEnabled, true),
          eq(apps.state, "active"),
        ),
      );

    const icon = record ? findAppIcon(assetManifest.parse(record.manifest)) : null;

    return icon
      ? Result.ok(icon)
      : Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App icon not found" }));
  });

  if (selected.isErr()) return selected;
  const icon = selected.value;
  const downloaded = await storage.get(`apps/${appId}/assets/${icon.hash}`);

  if (downloaded.isErr()) return downloaded;

  if (downloaded.value.byteLength !== icon.size)
    return Result.err(new InvalidOperation({ code: "NOT_FOUND", message: "App icon not found" }));

  return Result.ok({ bytes: downloaded.value, contentType: icon.contentType });
};
