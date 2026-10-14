import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createTestEnvironment } from "./environment.ts";
import { cloudflareSubscriptionUpdates } from "../src/lib/server/schema.ts";
import { CloudflareApiError } from "../src/lib/server/cloudflare-provisioning.ts";
import {
  CloudflareSubscriptionPending,
  updateCloudflareSubscription,
} from "../src/lib/server/cloudflare-subscription-updates.ts";

describe("Cloudflare schedule and consumer mutation fences", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  afterAll(async () => {
    await environment.close();
  });

  const fixture = () => {
    const scope = crypto.randomUUID();
    let current: string[] = [];
    let mode = "normal";
    const held: (() => void)[] = [];
    const writes: string[][] = [];

    return {
      writes,
      held,
      next: (value: string) => {
        mode = value;
      },
      current: () => current,
      pending: async () =>
        (
          await environment.database.db
            .select()
            .from(cloudflareSubscriptionUpdates)
            .where(eq(cloudflareSubscriptionUpdates.scope, scope))
        )[0]?.pending,
      update: (desired: string[]) =>
        updateCloudflareSubscription(
          environment.database.db,
          scope,
          z.array(z.string()),
          async () => current,
          async () => desired,
          async (target) => {
            writes.push(target);
            const behavior = mode;
            mode = "normal";

            if (behavior === "rejected") throw new CloudflareApiError(403);

            const apply = () => {
              current = target;
            };

            if (behavior === "delayed") {
              held.push(apply);
              throw new Error("Timeout");
            }

            apply();

            if (behavior === "lost") throw new Error("Lost response");

            if (behavior === "held-response")
              await new Promise<void>((resolve) => {
                held.push(resolve);
              });
          },
        ),
    };
  };

  it("blocks later changes until a delayed native update is confirmed", async () => {
    const cloud = fixture();
    cloud.next("delayed");
    await expect(cloud.update(["A"])).rejects.toBeInstanceOf(CloudflareSubscriptionPending);
    const pending = await cloud.pending();

    for (const desired of [["A"], ["B"], []])
      await expect(cloud.update(desired)).rejects.toBeInstanceOf(CloudflareSubscriptionPending);
    expect(cloud.writes).toEqual([["A"]]);
    expect(await cloud.pending()).toEqual(pending);
    cloud.held.shift()?.();
    await cloud.update(["B"]);
    expect(cloud.current()).toEqual(["B"]);
    expect(await cloud.pending()).toBeNull();
  });
  it("confirms lost responses including removals without repeating writes", async () => {
    const cloud = fixture();

    for (const desired of [["A"], []]) {
      cloud.next("lost");
      await expect(cloud.update(desired)).rejects.toBeInstanceOf(CloudflareSubscriptionPending);
      await cloud.update(desired);
      expect(await cloud.pending()).toBeNull();
    }

    expect(cloud.writes).toEqual([["A"], []]);
  });
  it("does not clear a newer pending change on an older acknowledgement", async () => {
    const cloud = fixture();
    cloud.next("held-response");
    const first = cloud.update(["A"]);
    await expect.poll(() => cloud.held.length).toBe(1);
    cloud.next("delayed");
    await expect(cloud.update(["B"])).rejects.toBeInstanceOf(CloudflareSubscriptionPending);
    const pending = await cloud.pending();
    cloud.held.shift()?.();
    await first;
    expect(await cloud.pending()).toEqual(pending);
    cloud.held.shift()?.();
    await cloud.update(["B"]);
    expect(cloud.writes).toHaveLength(2);
  });
  it("releases explicit rejection and isolates unrelated subscription scopes", async () => {
    const cloud = fixture();
    cloud.next("rejected");
    await expect(cloud.update(["A"])).rejects.toThrow("HTTP 403");
    expect(await cloud.pending()).toBeNull();
    cloud.next("delayed");
    await expect(cloud.update(["A"])).rejects.toBeInstanceOf(CloudflareSubscriptionPending);
    const independent = fixture();
    await independent.update(["B"]);
    expect(independent.current()).toEqual(["B"]);
    expect(await cloud.pending()).not.toBeNull();
  });
});
