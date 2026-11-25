import type { z } from "zod";
import {
  CloudflareApiError,
  createCloudflareProvisioner,
} from "../src/lib/server/cloudflare-provisioning.ts";
import { hostedResourceNames, type hostedInstallation } from "./hosted-configuration.ts";

export const provisionHostedResources = async (
  installation: z.infer<typeof hostedInstallation>,
  cloudflare: ReturnType<typeof createCloudflareProvisioner>,
  wrangler: (args: string[]) => Promise<void>,
) => {
  const names = hostedResourceNames(installation);

  try {
    await cloudflare.call("get R2 bucket", () =>
      cloudflare.client.r2.buckets.get(names.artifacts, cloudflare.account),
    );
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    await wrangler([
      "r2",
      "bucket",
      "create",
      names.artifacts,
      "--location",
      installation.storageLocation,
    ]);
  }

  let auth = await cloudflare.findNamespace(names.auth);

  if (!auth) {
    await wrangler(["kv", "namespace", "create", names.auth, "--no-update-config"]);
    auth = await cloudflare.findNamespace(names.auth);
  }

  // Preserve the existing Hyperdrive's credentials and TLS configuration.
  // Custom verify modes require an uploaded CA; setup only manages caching.
  await wrangler(["hyperdrive", "update", installation.hyperdriveId, "--caching-disabled"]);

  if (!auth) throw new Error("The created Auth KV namespace could not be found");

  return { auth };
};

/**
 * A deployment that omits PLATFORM_ENCRYPTION_KEYS leaves the deployed secret in
 * place, but initialization reads stored secrets here and needs the same keys.
 * Stops before any change instead of failing during initialization.
 */
export const requireHostedKeyring = async (
  installation: z.infer<typeof hostedInstallation>,
  cloudflare: ReturnType<typeof createCloudflareProvisioner>,
  keys: string | undefined,
) => {
  if (keys) return;

  try {
    const deployed = await cloudflare.call("list control plane secrets", async () => {
      for await (const secret of cloudflare.client.workers.scripts.secrets.list(
        hostedResourceNames(installation).controlPlane,
        cloudflare.account,
      ))
        if (secret.name === "PLATFORM_ENCRYPTION_KEYS") return true;

      return false;
    });

    if (deployed)
      throw new Error(
        "The deployed control plane uses PLATFORM_ENCRYPTION_KEYS. Supply the same keyring to deploy it.",
      );
  } catch (error) {
    // A first deployment has no control plane Worker yet.
    if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
  }
};
