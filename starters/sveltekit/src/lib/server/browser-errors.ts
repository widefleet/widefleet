import { z } from "zod";
import type { RequestEvent } from "@sveltejs/kit";
import { browserError } from "../errors.ts";

const windows = new Map<string, { start: number; count: number }>();

const duplicates = new Map<string, number>();

export const receiveBrowserError = async (event: RequestEvent) => {
  const { request, url } = event;

  if (request.method !== "POST") return new Response(null, { status: 405 });

  if (request.headers.get("origin") !== url.origin) return new Response(null, { status: 403 });

  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return new Response(null, { status: 415 });

  const now = Date.now();

  for (const [key, value] of windows) {
    if (now - value.start >= 60_000) windows.delete(key);
  }

  for (const [key, timestamp] of duplicates) {
    if (now - timestamp >= 60_000) duplicates.delete(key);
  }

  const user = event.locals.user.id;
  const window = windows.get(user) ?? { start: now, count: 0 };

  if (window.count >= 30 || (!windows.has(user) && windows.size >= 1000))
    return new Response(null, { status: 429, headers: { "retry-after": "60" } });
  window.count += 1;
  windows.set(user, window);

  const reader = request.body?.getReader();

  if (!reader) return new Response(null, { status: 400 });
  const buffer = new Uint8Array(32 * 1024);
  let length = 0;

  try {
    while (true) {
      const part = await reader.read();

      if (part.done) break;
      const value = z.instanceof(Uint8Array).parse(part.value);

      if (length + value.length > buffer.length) {
        await reader.cancel();

        return new Response(null, { status: 413 });
      }

      buffer.set(value, length);
      length += value.length;
    }

    const parsed = browserError.safeParse(
      JSON.parse(new TextDecoder().decode(buffer.subarray(0, length))),
    );

    if (!parsed.success) return new Response(null, { status: 400 });
    const entry = parsed.data;
    const key = `${user}:${entry.id}`;

    if (!duplicates.has(key)) {
      if (duplicates.size >= 1000) return new Response(null, { status: 429 });
      duplicates.set(key, now);
      console.error(
        JSON.stringify({
          widefleet: 1,
          kind: "error",
          source: "browser",
          ...entry,
          requestId: event.locals.requestId,
        }),
      );
    }

    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 400 });
  } finally {
    reader.releaseLock();
  }
};
