import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { publishAppExecutionAvailability } from "../src/lib/server/execution-availability.ts";

describe("Execution availability publication", () => {
  it("publishes every app through the management binding and requires acknowledgement", async () => {
    const ids = Array.from({ length: 23 }, () => crypto.randomUUID());
    const received: { appId: string; blocked: boolean }[] = [];

    const runtime = {
      fetch: vi.fn<typeof fetch>(async function (this: { fetch: typeof fetch }, input, init) {
        expect(this).toBe(runtime);
        const request = new Request(input, init);
        expect(request.url).toBe("https://runtime.internal/.well-known/widefleet/execution");
        expect(request.method).toBe("POST");
        expect(request.redirect).toBe("manual");

        const body = z
          .object({ appId: z.uuid(), blocked: z.boolean() })
          .parse(await request.json());

        received.push(body);

        return new Response(null, { status: body.appId === ids[0] ? 503 : 204 });
      }),
    };

    await expect(publishAppExecutionAvailability(runtime, ids, true)).rejects.toThrow(
      "Execution availability publication failed",
    );
    expect(received).toEqual(ids.map((appId) => ({ appId, blocked: true })));
    runtime.fetch.mockImplementation(async () => new Response(null, { status: 204 }));
    await publishAppExecutionAvailability(runtime, ids, false);
    expect(runtime.fetch).toHaveBeenCalledTimes(46);
  });

  it("rejects a legacy runtime's successful fallback response", async () => {
    const runtime = { fetch: vi.fn<typeof fetch>(async () => new Response("fallback")) };
    await expect(
      publishAppExecutionAvailability(runtime, [crypto.randomUUID()], true),
    ).rejects.toThrow();
  });
});
