import { eq } from "drizzle-orm";
import {
  appGrants,
  apps,
  artifacts,
  cloudflareOperations,
  deployments,
  jobs,
  uploadSessions,
} from "./schema.ts";
import type { Transaction } from "./transactions.ts";

// The caller holds the app lock and has completed resource cleanup. Preserve
// its identity, but remove the dependents previously deleted by the app FK.
export const finishAppRemoval = async (transaction: Transaction, appId: string) => {
  await transaction.delete(appGrants).where(eq(appGrants.appId, appId));
  await transaction.delete(uploadSessions).where(eq(uploadSessions.appId, appId));
  await transaction.delete(jobs).where(eq(jobs.appId, appId));
  await transaction.delete(cloudflareOperations).where(eq(cloudflareOperations.appId, appId));
  await transaction.delete(deployments).where(eq(deployments.appId, appId));
  await transaction.delete(artifacts).where(eq(artifacts.appId, appId));
  await transaction
    .update(apps)
    .set({ removedAt: new Date(), activeDeploymentId: null, catalogListed: false })
    .where(eq(apps.id, appId));
};
