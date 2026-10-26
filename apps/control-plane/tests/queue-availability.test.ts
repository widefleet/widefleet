import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { cloudflareResourceName } from "../src/lib/server/cloudflare-provisioning.ts";
import { createQueueAvailabilityPublisher } from "../src/lib/server/queue-availability.ts";

const registration = (names: string[], deleted = false) => ({
  hostname: "example.apps.test",
  deleted,
  sequence: 1,
  published: { crons: [], queue_consumers: names.map((queue) => ({ queue })) },
  pending: {},
  queues: names,
});

const fixture = () => {
  const apps: Record<string, ReturnType<typeof registration>> = {};

  const queues = new Map<
    string,
    {
      queue_id: string;
      queue_name: string;
      settings: { delivery_paused: boolean; delivery_delay: number };
    }
  >();

  const fail = new Set<string>();

  const storage = {
    get: vi.fn(async (_key: string) => ({
      text: async () => JSON.stringify({ apps, configuration: { crons: {}, queues: {} } }),
    })),
  };

  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");

    const ok = (result: z.infer<ReturnType<typeof z.json>>) =>
      Response.json({ success: true, result });

    if (request.method === "GET" && url.pathname === "/client/v4/accounts/fixture/queues") {
      const page = Number(url.searchParams.get("page"));
      expect(url.searchParams.get("per_page")).toBe("100");

      return ok([...queues.values()].slice((page - 1) * 100, page * 100));
    }

    const id = url.pathname.split("/").at(-1);
    const queue = [...queues.values()].find((value) => value.queue_id === id);
    expect(request.method).toBe("PATCH");

    if (!queue) throw new Error("Unexpected queue operation");

    if (fail.has(queue.queue_name)) return new Response(null, { status: 503 });

    const body = z
      .strictObject({
        settings: z.strictObject({ delivery_paused: z.boolean() }),
      })
      .parse(await request.json());

    queue.settings.delivery_paused = body.settings.delivery_paused;

    return ok(queue);
  });

  const add = (appId: string, name: string, paused = false) => {
    const queue_name = cloudflareResourceName(appId, "queue", name);

    const value = {
      queue_id: crypto.randomUUID(),
      queue_name,
      settings: { delivery_paused: paused, delivery_delay: 30 },
    };

    queues.set(queue_name, value);

    return value;
  };

  const create = () =>
    createQueueAvailabilityPublisher(
      storage,
      { accountId: "fixture", token: "fixture-token" },
      transport,
    );

  const patches = () =>
    transport.mock.calls.filter(([input, init]) => new Request(input, init).method === "PATCH");

  return { apps, queues, storage, transport, add, create, patches, fail };
};

describe("App queue delivery availability", () => {
  it("pauses only owned queues, writes only changes and resumes on a fresh evaluation", async () => {
    const state = fixture();
    state.apps["one"] = registration(["jobs"]);
    state.apps["two"] = registration(["jobs"]);
    const first = state.add("one", "jobs");
    const other = state.add("two", "jobs");
    const unrelated = state.add("unregistered", "jobs", true);
    const publish = state.create();
    await publish(["one"], true);
    await publish(["two"], false);
    await publish(["one"], true);
    expect(first.settings).toEqual({ delivery_paused: true, delivery_delay: 30 });
    expect(other.settings.delivery_paused).toBe(false);
    expect(unrelated.settings.delivery_paused).toBe(true);
    expect(state.patches()).toHaveLength(1);
    expect(state.storage.get).toHaveBeenCalledExactlyOnceWith("events/configuration.json");
    expect(state.transport).toHaveBeenCalledTimes(2);
    await state.create()(["one"], true);
    expect(state.patches()).toHaveLength(1);
    await state.create()(["one"], false);
    expect(first.settings.delivery_paused).toBe(false);
    expect(state.patches()).toHaveLength(2);
  });

  it("reads all provider pages once and handles pending deployments without touching deleted apps", async () => {
    const state = fixture();

    for (let index = 0; index < 100; index++) state.add("unrelated", `queue-${index}`);
    state.apps["deleted"] = registration(["jobs"], true);
    const deleted = state.add("deleted", "jobs");
    state.apps["active"] = {
      ...registration(["jobs"]),
      pending: {
        deployment: {
          sequence: 2,
          activating: true,
          events: { crons: [], queue_consumers: [{ queue: "next" }] },
        },
      },
    };
    const active = state.add("active", "jobs");
    const next = state.add("active", "next");
    await state.create()(["deleted", "active"], true);
    expect(deleted.settings.delivery_paused).toBe(false);
    expect(active.settings.delivery_paused).toBe(true);
    expect(next.settings.delivery_paused).toBe(true);
    expect(state.transport).toHaveBeenCalledTimes(4);
  });

  it("skips provider calls when no queue consumers are registered", async () => {
    const state = fixture();
    state.apps["empty"] = registration([]);
    await state.create()(["empty"], true);
    expect(state.transport).not.toHaveBeenCalled();
  });

  it("reports partial failures, continues other queues and repairs on the next evaluation", async () => {
    const state = fixture();
    state.apps["one"] = registration(["first", "second"]);
    state.apps["two"] = registration(["jobs"]);
    const first = state.add("one", "first");
    const second = state.add("one", "second");
    const other = state.add("two", "jobs", true);
    state.fail.add(first.queue_name);
    const publish = state.create();
    await expect(publish(["one"], true)).rejects.toThrow("Queue delivery publication failed");
    await publish(["two"], false);
    expect(first.settings.delivery_paused).toBe(false);
    expect(second.settings.delivery_paused).toBe(true);
    expect(other.settings.delivery_paused).toBe(false);
    expect(state.patches()).toHaveLength(3);
    state.fail.clear();
    await state.create()(["one"], true);
    expect(first.settings.delivery_paused).toBe(true);
    expect(state.patches()).toHaveLength(4);
  });

  it("does not treat a failed provider read or a missing registered queue as successful publication", async () => {
    const state = fixture();
    state.apps["one"] = registration(["jobs"]);
    const first = state.add("one", "jobs", true);
    state.transport.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const publish = state.create();
    await expect(publish(["one"], false)).rejects.toThrow();
    await expect(publish(["one"], false)).rejects.toThrow();
    expect(state.transport).toHaveBeenCalledTimes(1);
    expect(first.settings.delivery_paused).toBe(true);
    state.queues.clear();
    await expect(state.create()(["one"], true)).rejects.toThrow(
      "Queue delivery publication failed",
    );
    expect(state.patches()).toHaveLength(0);
  });

  it("rejects invalid registry data before contacting the provider", async () => {
    const state = fixture();
    state.storage.get.mockResolvedValueOnce({
      text: async () => JSON.stringify({ apps: "invalid" }),
    });
    await expect(state.create()(["one"], false)).rejects.toThrow();
    expect(state.transport).not.toHaveBeenCalled();
  });
});
