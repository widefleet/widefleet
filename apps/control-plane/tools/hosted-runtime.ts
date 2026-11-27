import { eq } from "drizzle-orm";
import { z } from "zod";
import type { runtimeRelease } from "@platform/contracts";
import type { Database } from "../src/lib/server/database.ts";
import type { ArtifactStorage } from "../src/lib/server/storage.ts";
import type { createCloudflareProvisioner } from "../src/lib/server/cloudflare-provisioning.ts";
import { CloudflareBindingUpdatePending } from "../src/lib/server/cloudflare-binding-updates.ts";
import { validateCloudflareRuntime } from "../src/lib/server/cloudflare-runtime-package.ts";
import {
  installationRuntime,
  lockOrganizationRuntime,
} from "../src/lib/server/organization-runtime.ts";
import { cloudflareRuntimeBindings, organizationRuntimes } from "../src/lib/server/schema.ts";
import { saveRuntime } from "../src/lib/server/runtime-releases.ts";

export const deployHostedRuntime = (
  database: Database,
  cloudflare: ReturnType<typeof createCloudflareProvisioner>,
  storage: Pick<ArtifactStorage, "put">,
  release: z.infer<typeof runtimeRelease>,
  deploy: (confirmedBindingTag: string | undefined) => Promise<void>,
) =>
  database.transaction(async (transaction) => {
    validateCloudflareRuntime(release);

    const execution = await lockOrganizationRuntime(
      transaction,
      (await installationRuntime(transaction)).organizationId,
    );

    if (execution.executor !== "cloudflare") throw new Error("Expected a Hosted installation");
    await transaction
      .insert(cloudflareRuntimeBindings)
      .values({ scope: cloudflare.scope })
      .onConflictDoNothing();

    const [bindings] = await transaction
      .select()
      .from(cloudflareRuntimeBindings)
      .where(eq(cloudflareRuntimeBindings.scope, cloudflare.scope))
      .for("update");

    if (!bindings) throw new Error("Runtime binding state not found");

    const pending =
      bindings.pending === null ? null : z.object({ id: z.uuid() }).parse(bindings.pending);

    if (pending) {
      const current = await cloudflare.readBindings();

      if (current.annotations?.["workers/tag"] !== pending.id)
        throw new CloudflareBindingUpdatePending(cloudflare.scope, pending.id);
      await transaction
        .update(cloudflareRuntimeBindings)
        .set({ pending: null })
        .where(eq(cloudflareRuntimeBindings.scope, cloudflare.scope));
    }

    // Use the existing execution/binding locks; app provisioning and code updates wait
    // for this explicit infrastructure deployment. Provider timeouts still require
    // the operator to inspect the outcome before running another deployment.
    const reference = await saveRuntime(transaction, storage, release);
    // Preserve an observed confirmation on the new version too. If verification
    // fails and SQL rolls back, the next attempt can still confirm that write.
    await deploy(pending?.id);
    await transaction
      .update(organizationRuntimes)
      .set({
        runtime: reference,
        appliedRuntime: reference,
        // Advance the existing selection marker even without a Workflow job;
        // commands prepared before this deployment must not replace its runtime.
        runtimeJobId: crypto.randomUUID(),
      })
      .where(eq(organizationRuntimes.organizationId, execution.organizationId));
  });

// A new Worker version takes a few seconds to reach every Cloudflare location, so
// a check right after the deployment can still reach the previous version, which
// may not answer in the same shape yet.
export const waitForRuntime = async (
  isActive: () => Promise<boolean>,
  { attempts = 30, interval = 2_000 } = {},
) => {
  let failure: unknown;

  for (let attempt = 1; ; attempt++) {
    try {
      if (await isActive()) return;
    } catch (error) {
      failure = error;
    }

    if (attempt >= attempts)
      throw new Error("The requested Runtime version is not active", { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};
