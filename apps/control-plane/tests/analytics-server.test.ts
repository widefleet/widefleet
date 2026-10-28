import { z } from "zod";
import { expect, it, vi } from "vitest";
import { createProductAnalytics } from "../src/lib/server/analytics.ts";
import { analyticsEnvironment } from "./analytics-fixture.ts";

const eventSchema = z.object({
  event: z.string(),
  distinct_id: z.string(),
  properties: z.record(z.string(), z.json()),
});

const fixture = () => {
  const events: z.infer<typeof eventSchema>[] = [];

  const transport = vi.fn<typeof fetch>(async (url, options) => {
    const request = new Request(url, options);

    const body =
      request.headers.get("content-encoding") === "gzip"
        ? request.body?.pipeThrough(new DecompressionStream("gzip"))
        : request.body;

    events.push(
      ...z.object({ batch: z.array(eventSchema) }).parse(await new Response(body).json()).batch,
    );

    return new Response("{}");
  });

  return { events, transport, observer: createProductAnalytics(analyticsEnvironment, transport) };
};

it("captures anonymous decisions without creating person profiles", async () => {
  const { events, observer } = fixture();
  observer.capture({
    event: "authentication_decision",
    id: "attempt-a",
    anonymousId: "opaque-subject",
    properties: { rule: "verification_required", action: "challenge" },
  });
  await observer.close();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event: "authentication_decision",
    distinct_id: "anonymous:opaque-subject",
    properties: { $process_person_profile: false, rule: "verification_required" },
  });
});

it("sends immediately with the browser user ID and organization group", async () => {
  const { events, observer } = fixture();
  observer.capture({
    event: "deployment_completed",
    id: "deployment:succeeded",
    userId: "a",
    organizationId: "org-a",
    properties: { outcome: "succeeded" },
  });
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(events[0]).toMatchObject({
    event: "deployment_completed",
    distinct_id: "user:a",
    properties: { $groups: { organization: "org-a" }, outcome: "succeeded" },
  });
  await observer.close();
});

it("stays inactive without configuration or on a different origin", async () => {
  const transport = vi.fn<typeof fetch>();

  for (const configuration of [
    { PLATFORM_URL: analyticsEnvironment.PLATFORM_URL },
    { ...analyticsEnvironment, PLATFORM_URL: "http://localhost" },
  ]) {
    const observer = createProductAnalytics(configuration, transport);
    observer.capture({ event: "user_created", id: "a", userId: "a" });
    await observer.close();
  }

  expect(transport).not.toHaveBeenCalled();
});

it("sends the original server exception and cause", async () => {
  const { events, observer } = fixture();
  observer.exception(
    new TypeError("Deployment failed", { cause: new Error("Connection refused") }),
  );
  await observer.close();
  expect(events[0]?.properties["$exception_list"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "TypeError", value: "Deployment failed" }),
      expect.objectContaining({ type: "Error", value: "Connection refused" }),
    ]),
  );
  expect(events[0]?.distinct_id).toBe("hosted:control-plane");
});

it("drains all captured events before closing", async () => {
  const { events, observer } = fixture();

  for (let i = 0; i < 30; i++)
    observer.capture({ event: "user_created", id: String(i), userId: String(i) });
  await observer.close();
  expect(events).toHaveLength(30);
});

it.each(["redirect", "network"])("isolates %s failures from request cleanup", async (failure) => {
  const transport = vi.fn<typeof fetch>(async () => {
    if (failure === "network") throw new Error("Unavailable");

    return new Response(null, { status: 307, headers: { location: "https://untrusted.example" } });
  });

  const observer = createProductAnalytics(analyticsEnvironment, transport);
  observer.capture({ event: "user_created", id: "a", userId: "a" });
  await expect(observer.close()).resolves.toBeUndefined();
  expect(transport.mock.calls[0]?.[1]?.redirect).toBe("manual");
});
