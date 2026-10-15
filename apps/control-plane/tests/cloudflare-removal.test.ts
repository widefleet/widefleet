import { describe, expect, it } from "vitest";
import * as contract from "@platform/contracts";
import {
  removalResources,
  removeCloudflareResource,
} from "../src/lib/server/cloudflare-removal-resources.ts";
import {
  CloudflareApiError,
  cloudflareResourceName,
  createCloudflareProvisioner,
} from "../src/lib/server/cloudflare-provisioning.ts";

const provisioner = (transport: typeof fetch) =>
  createCloudflareProvisioner(
    { accountId: "0".repeat(32), token: "fixture-token", runtimeName: "fixture-runtime" },
    transport,
  );

describe("Hosted app resource removal", () => {
  it("collects all app-owned resources from historical artifacts and deduplicates shared logical names", () => {
    const appId = crypto.randomUUID();

    const metadata = contract.workerMetadata.parse({
      main_module: "app.js",
      compatibility_date: "2026-10-01",
      assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
      bindings: [
        { type: "d1", name: "DB", database_id: "stable-id", database_name: "renamed" },
        { type: "r2_bucket", name: "FILES", bucket_name: "files" },
        { type: "kv_namespace", name: "CACHE", id: "cache" },
        { type: "queue", name: "JOBS", queue: "jobs" },
      ],
      queue_consumers: [{ queue: "jobs", dead_letter_queue: "failed" }],
    });

    const old = contract.workerMetadata.parse({
      main_module: "app.js",
      compatibility_date: "2026-10-01",
      assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
      bindings: [{ type: "d1", name: "OLD_DB", database_name: "old" }],
    });

    expect(removalResources(appId, [old, metadata, metadata])).toEqual(
      [
        ["d1", "old"],
        ["d1", "stable-id"],
        ["r2", "files"],
        ["kv", "cache"],
        ["queue", "jobs"],
        ["queue", "failed"],
      ].map(([kind, name]) => ({
        kind,
        name: cloudflareResourceName(appId, kind ?? "", name ?? ""),
      })),
    );
  });

  it("finds a KV namespace on a later page and accepts an empty successful delete response", async () => {
    const calls: string[] = [];

    const api = provisioner(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}${url.search}`);

      if (request.method === "DELETE") return new Response(null, { status: 204 });

      const result =
        url.searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}`, title: `other-${i}` }))
          : [{ id: "owned-id", title: "owned" }];

      return Response.json({ success: true, result });
    });

    expect(await removeCloudflareResource(api, { kind: "kv", name: "owned" })).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)).toContain(
      "DELETE /client/v4/accounts/" + "0".repeat(32) + "/storage/kv/namespaces/owned-id",
    );
  });

  it("accepts queue deletion without a result envelope and does not recreate an absent queue", async () => {
    let present = true;
    const methods: string[] = [];

    const api = provisioner(async (input, init) => {
      const request = new Request(input, init);
      methods.push(request.method);

      if (request.method === "GET")
        return Response.json({
          success: true,
          result: present ? [{ queue_id: "owned-id", queue_name: "owned" }] : [],
        });
      present = false;

      return Response.json({ success: true });
    });

    expect(await removeCloudflareResource(api, { kind: "queue", name: "owned" })).toBe(true);
    expect(await removeCloudflareResource(api, { kind: "queue", name: "owned" })).toBe(true);
    expect(methods).toEqual(["GET", "DELETE", "GET"]);
  });

  it("treats an already removed bucket as complete but propagates permission failures", async () => {
    const missing = provisioner(async () => new Response(null, { status: 404 }));
    expect(await removeCloudflareResource(missing, { kind: "r2", name: "gone" })).toBe(true);
    const denied = provisioner(async () => new Response(null, { status: 403 }));
    await expect(
      removeCloudflareResource(denied, { kind: "r2", name: "private" }),
    ).rejects.toBeInstanceOf(CloudflareApiError);
  });
});
