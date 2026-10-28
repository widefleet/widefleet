import { appendFile } from "node:fs/promises";
import { z } from "zod";

const destination = process.env["TEST_ANALYTICS_OUTPUT"];

const originalFetch = globalThis.fetch;

const batch = z.object({
  batch: z.array(z.object({ event: z.string(), distinct_id: z.string() })),
});

if (destination)
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    const url = new URL(request.url);

    if (url.origin === "https://eu.i.posthog.com") {
      const body =
        request.headers.get("content-encoding") === "gzip"
          ? request.body?.pipeThrough(new DecompressionStream("gzip"))
          : request.body;

      const events = batch.parse(await new Response(body).json());
      await appendFile(
        destination,
        events.batch.map((event) => `${JSON.stringify(event)}\n`).join(""),
      );

      return new Response("{}", { headers: { "content-type": "application/json" } });
    }

    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Unexpected external request in initialization fixture");

    return originalFetch(request);
  };
