import { z } from "zod";
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

  const findAuth = async () => {
    for (let page = 1; ; page++) {
      const entries = z
        .array(z.object({ id: z.string(), title: z.string() }))
        .parse(await cloudflare.request(`/storage/kv/namespaces?page=${page}&per_page=100`));

      const found = entries.find((entry) => entry.title === names.auth);

      if (found) return found.id;

      if (entries.length < 100) return null;
    }
  };

  try {
    await cloudflare.request(`/r2/buckets/${encodeURIComponent(names.artifacts)}`);
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    await wrangler(["r2", "bucket", "create", names.artifacts]);
  }

  let auth = await findAuth();

  if (!auth) {
    await wrangler(["kv", "namespace", "create", names.auth, "--no-update-config"]);
    auth = await findAuth();
  }

  // The existing Hyperdrive owns the application's database credentials. The
  // deployment role's DATABASE_URL must never replace that connection.
  await wrangler([
    "hyperdrive",
    "update",
    installation.hyperdriveId,
    "--caching-disabled",
    "--sslmode",
    "verify-full",
  ]);

  if (!auth) throw new Error("The created Auth KV namespace could not be found");

  return { auth };
};
