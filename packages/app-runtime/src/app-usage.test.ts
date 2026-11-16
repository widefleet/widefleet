import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeUsage } from "@platform/contracts";
import type { z } from "zod";
import { createRuntimeUsage } from "./app-usage.ts";

const settings = {
  url: "https://installation.example.test/api/v1/reporting/runtime/widefleet",
  token: `usage_${"a".repeat(64)}`,
  organizationId: "widefleet",
  enabled: true,
  revision: 0,
};

const fixture = () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-22T23:59:00Z"));
  const batches: z.infer<typeof runtimeUsage>[] = [];
  let response = { enabled: true, revision: 0 };
  let offline = false;
  const pending: Promise<unknown>[] = [];

  const record = createRuntimeUsage(settings, async (url, init) => {
    expect(url).toBe(settings.url);
    expect(init?.redirect).toBe("manual");
    batches.push(runtimeUsage.parse(await new Request(settings.url, init).json()));

    if (offline) throw new Error("offline");

    return Response.json(response);
  });

  return {
    batches,
    record: (id: string) =>
      record(id, {
        waitUntil: (task) => {
          pending.push(task);
        },
      }),
    flush: async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await Promise.all(pending.splice(0));
    },
    status: (enabled: boolean, revision: number) => {
      response = { enabled, revision };
    },
    offline: (value: boolean) => {
      offline = value;
    },
  };
};

afterEach(() => vi.useRealTimers());

describe("Runtime usage aggregation", () => {
  it("reports every app even when the installation exceeds a single batch", async () => {
    const runtime = fixture();
    const apps = Array.from({ length: 1500 }, () => crypto.randomUUID());

    for (const app of apps) runtime.record(app);
    await runtime.flush();
    expect(runtime.batches.flatMap((batch) => batch.counts.map((item) => item.appId))).toEqual(
      apps,
    );
  });

  it("batches calls, retries cumulative totals and separates UTC calendar weeks", async () => {
    const runtime = fixture();
    const app = crypto.randomUUID();
    const preview = crypto.randomUUID();
    runtime.record(app);
    runtime.record(app);
    runtime.record(preview);
    expect(runtime.batches).toEqual([]);
    runtime.offline(true);
    await runtime.flush();
    expect(runtime.batches[0]?.counts).toEqual([
      { appId: app, weekStart: "2026-11-16", invocations: 2 },
      { appId: preview, weekStart: "2026-11-16", invocations: 1 },
    ]);
    runtime.record(app);
    runtime.offline(false);
    await runtime.flush();
    expect(runtime.batches[1]?.source).toBe(runtime.batches[0]?.source);
    expect(runtime.batches[1]?.counts[0]?.invocations).toBe(3);
    vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    runtime.record(app);
    await runtime.flush();
    expect(runtime.batches[2]?.counts).toEqual([
      { appId: app, weekStart: "2026-11-23", invocations: 1 },
    ]);
  });

  it("discards buffered counts on preference changes and polls without app IDs while disabled", async () => {
    const runtime = fixture();
    const app = crypto.randomUUID();
    runtime.record(app);
    runtime.status(false, 1);
    await runtime.flush();
    runtime.record(app);
    await runtime.flush();
    expect(runtime.batches[1]?.counts).toEqual([]);
    expect(runtime.batches[1]?.revision).toBe(1);
    runtime.status(true, 2);
    runtime.record(app);
    await runtime.flush();
    expect(runtime.batches[2]?.counts).toEqual([]);
    runtime.record(app);
    await runtime.flush();
    expect(runtime.batches[3]?.counts[0]?.invocations).toBe(1);
    expect(runtime.batches[3]?.revision).toBe(2);
    expect(runtime.batches[3]?.source).not.toBe(runtime.batches[0]?.source);
  });

  it("does not lose increments arriving while a batch is in flight", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const batches: z.infer<typeof runtimeUsage>[] = [];
    const pending: Promise<unknown>[] = [];

    const context = {
      waitUntil: (task: Promise<unknown>) => {
        pending.push(task);
      },
    };

    const record = createRuntimeUsage(settings, async (_url, init) => {
      batches.push(runtimeUsage.parse(await new Request(settings.url, init).json()));
      await gate;

      return Response.json({ enabled: true, revision: 0 });
    });

    const app = crypto.randomUUID();
    record(app, context);
    await vi.advanceTimersByTimeAsync(5000);
    record(app, context);
    release?.();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pending);
    expect(batches.map((batch) => batch.counts[0]?.invocations)).toEqual([1, 2]);
  });
});
