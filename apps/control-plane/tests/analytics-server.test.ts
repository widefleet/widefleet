import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createProductAnalytics } from "../src/lib/server/analytics.ts";
import { analyticsEnvironment } from "./analytics-fixture.ts";

const batchSchema = z.object({
  batch: z.array(
    z.object({
      event: z.string(),
      distinct_id: z.string(),
      uuid: z.string(),
      properties: z.record(z.string(), z.json()),
    }),
  ),
});

describe("Server product analytics", () => {
  it("uses the same user/org identity and stable event UUIDs across retries", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));

    for (let i = 0; i < 2; i++) {
      const observer = createProductAnalytics(analyticsEnvironment, transport);
      observer.capture({
        event: "deployment_completed",
        id: "deployment:succeeded",
        userId: "user-a",
        organizationId: "org-a",
        properties: { outcome: "succeeded" },
      });
      await observer.close();
      await observer.close();
    }

    const bodies = await Promise.all(
      transport.mock.calls.map(async ([, options]) =>
        batchSchema.parse(JSON.parse(await new Response(options?.body).text())),
      ),
    );

    expect(transport).toHaveBeenCalledTimes(2);
    expect(bodies[0]?.batch[1]?.properties).toMatchObject({
      $groups: { organization: "org-a" },
      outcome: "succeeded",
    });
    expect(bodies[0]?.batch[1]?.distinct_id).toBe("user:user-a");
    expect(bodies[0]?.batch[0]?.event).toBe("$groupidentify");
    expect(bodies[0]?.batch[1]?.uuid).toBe(bodies[1]?.batch[1]?.uuid);
  });

  it("does not send from local installations or empty requests", async () => {
    const transport = vi.fn<typeof fetch>();

    const observer = createProductAnalytics(
      { ...analyticsEnvironment, PLATFORM_URL: "http://localhost" },
      transport,
    );

    const unconfigured = createProductAnalytics(
      { PLATFORM_URL: analyticsEnvironment.PLATFORM_URL },
      transport,
    );

    unconfigured.capture({ event: "user_created", id: "user-a", userId: "user-a" });
    await unconfigured.close();
    observer.capture({ event: "user_created", id: "user-a", userId: "user-a" });
    await observer.close();
    await createProductAnalytics(analyticsEnvironment, transport).close();
    expect(transport).not.toHaveBeenCalled();
  });

  it("sends original server error messages, causes and stack frames through the SDK", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const observer = createProductAnalytics(analyticsEnvironment, transport);

    const error = new TypeError("Cannot read deployment status", {
      cause: new Error("Connection refused"),
    });

    error.stack =
      "TypeError: Cannot read deployment status\n    at readDeployment (/app/server.js:42:7)";
    observer.exception?.(error);
    await observer.close();

    const body = batchSchema.parse(
      JSON.parse(await new Response(transport.mock.calls[0]?.[1]?.body).text()),
    );

    const event = body.batch.find((item: { event: string }) => item.event === "$exception");
    expect(event?.distinct_id).toBe("hosted:control-plane");
    expect(event?.properties["$exception_list"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "TypeError", value: "Cannot read deployment status" }),
        expect.objectContaining({ type: "Error", value: "Connection refused" }),
      ]),
    );
    expect(JSON.stringify(event?.properties["$exception_list"])).toContain("/app/server.js");
    expect(event?.properties["$process_person_profile"]).toBe(false);
  });

  it("continues delivering after the first batch on a long-lived server", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const observer = createProductAnalytics(analyticsEnvironment, transport);

    for (let i = 0; i < 20; i++)
      observer.capture({ event: "user_created", id: String(i), userId: String(i) });

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));

    for (let i = 20; i < 30; i++)
      observer.capture({ event: "user_created", id: String(i), userId: String(i) });

    await observer.close();

    const batches = await Promise.all(
      transport.mock.calls.map(
        async ([, options]) =>
          batchSchema.parse(JSON.parse(await new Response(options?.body).text())).batch,
      ),
    );

    expect(batches.flat()).toHaveLength(30);
    expect(batches.flat().map((event) => event.distinct_id)).toContain("user:29");
  });

  it("absorbs upstream redirects without following them", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://untrusted.example/batch/" },
      }),
    );

    const observer = createProductAnalytics(analyticsEnvironment, transport);
    observer.capture({ event: "user_created", id: "fixture", userId: "fixture" });
    await expect(observer.close()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("bounds queues and absorbs network failures", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("unavailable"));
    const observer = createProductAnalytics(analyticsEnvironment, transport);

    for (let i = 0; i < 30; i++)
      observer.capture({ event: "user_created", id: String(i), userId: String(i) });
    await expect(observer.close()).resolves.toBeUndefined();

    const body = batchSchema.parse(
      JSON.parse(await new Response(transport.mock.calls[0]?.[1]?.body).text()),
    );

    expect(body.batch).toHaveLength(20);
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});
