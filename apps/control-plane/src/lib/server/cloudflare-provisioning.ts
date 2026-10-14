import { createHash } from "node:crypto";
import type * as contract from "@platform/contracts";
import { z } from "zod";

const envelope = z.object({ success: z.boolean(), result: z.unknown() });

const database = z.object({ uuid: z.uuid(), name: z.string() });

const bucket = z.object({ name: z.string() });

const workerBindings = z.object({
  annotations: z.object({ "workers/tag": z.string().optional() }).optional(),
  bindings: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      id: z.string().optional(),
      database_id: z.string().optional(),
      bucket_name: z.string().optional(),
      jurisdiction: z.string().optional(),
    }),
  ),
});

export const cloudflareResource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("d1"), name: z.string(), id: z.string() }),
  z.object({ type: z.literal("r2_bucket"), name: z.string(), bucket_name: z.string() }),
]);

export class CloudflareApiError extends Error {
  constructor(readonly status: number) {
    // Upstream bodies can contain configuration and credentials. Keep them out of job logs.
    super(`Cloudflare provisioning request failed (HTTP ${status})`);
    this.name = "CloudflareApiError";
  }
}

export const createCloudflareProvisioner = (
  configuration: { accountId: string; token: string; runtimeName: string },
  transport: typeof fetch = fetch,
) => {
  const root = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}`;

  const request = async (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${configuration.token}`);

    const response = await transport(`${root}${path}`, {
      ...options,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new CloudflareApiError(response.status);
    }

    const body = envelope.parse(await response.json());

    if (!body.success) throw new CloudflareApiError(response.status);

    return body.result;
  };

  const findDatabase = async (name: string) => {
    for (let page = 1; ; page++) {
      const found = z
        .array(database)
        .parse(
          await request(`/d1/database?name=${encodeURIComponent(name)}&page=${page}&per_page=100`),
        );

      const match = found.find((entry) => entry.name === name);

      if (match) return match.uuid;

      if (found.length < 100) return null;
    }
  };

  const ensureDatabase = async (name: string) => {
    const existing = await findDatabase(name);

    if (existing) return existing;

    const created = database.parse(
      await request("/d1/database", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );

    if (created.name !== name) throw new Error("Cloudflare returned an unexpected database");

    return created.uuid;
  };

  const ensureBucket = async (name: string) => {
    try {
      const existing = bucket.parse(await request(`/r2/buckets/${encodeURIComponent(name)}`));

      if (existing.name !== name) throw new Error("Cloudflare returned an unexpected bucket");
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;

      const created = bucket.parse(
        await request("/r2/buckets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        }),
      );

      if (created.name !== name) throw new Error("Cloudflare returned an unexpected bucket");
    }
  };

  return {
    scope: `${configuration.accountId}/${configuration.runtimeName}`,
    readBindings: async () =>
      workerBindings.parse(
        await request(`/workers/scripts/${encodeURIComponent(configuration.runtimeName)}/settings`),
      ),
    writeBindings: async (
      id: string,
      retained: string[],
      resources: z.infer<typeof cloudflareResource>[],
    ) => {
      const settings = new FormData();
      settings.set(
        "settings",
        JSON.stringify({
          annotations: { "workers/tag": id },
          bindings: [
            // Inheritance preserves secrets, native bindings and retained app versions.
            ...retained.map((name) => ({ name, type: "inherit" })),
            ...resources,
          ],
        }),
      );
      await request(`/workers/scripts/${encodeURIComponent(configuration.runtimeName)}/settings`, {
        method: "PATCH",
        body: settings,
      });
    },
    provision: async (app: Pick<z.infer<typeof contract.artifact>, "appId" | "metadata">) => {
      const nativeBindings: Record<string, string> = {};
      const resources: z.infer<typeof cloudflareResource>[] = [];

      for (const binding of app.metadata.bindings) {
        if (binding.type === "plain_text") continue;

        if (binding.type !== "d1" && binding.type !== "r2_bucket")
          throw new Error(`Cloudflare provisioning for ${binding.type} is not available yet`);

        const kind = binding.type === "d1" ? "d1" : "r2";

        const logicalName =
          binding.type === "d1"
            ? (binding.database_id ?? binding.database_name)
            : binding.bucket_name;

        // App IDs isolate production and previews; names remain stable across job retries.
        const name = `r${createHash("sha256").update(`${app.appId}/${kind}/${logicalName}`).digest("hex").slice(0, 40)}`;
        const native = `B_${name}`;
        nativeBindings[binding.name] = native;

        if (resources.some((resource) => resource.name === native)) continue;

        if (binding.type === "d1") {
          resources.push({ type: "d1", name: native, id: await ensureDatabase(name) });
        } else {
          await ensureBucket(name);
          resources.push({ type: "r2_bucket", name: native, bucket_name: name });
        }
      }

      return { nativeBindings, resources };
    },
  };
};
