import { describe, expect, it } from "vitest";
import { readBytes } from "./bytes.ts";

describe("bounded downloads", () => {
  it("enforces the limit when the server omits or understates Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });

    expect(await readBytes(new Response(body, { headers: { "content-length": "1" } }), 4)).toEqual({
      status: "too_large",
      maximumBytes: 4,
    });
    expect(await readBytes(new Response("hello"), 4)).toEqual({
      status: "too_large",
      maximumBytes: 4,
    });
  });

  it("returns empty and binary files without text conversion", async () => {
    expect(await readBytes(new Response(null))).toEqual({
      status: "connected",
      data: new Uint8Array(),
    });
    expect(await readBytes(new Response(new Uint8Array([0, 255, 1])))).toEqual({
      status: "connected",
      data: new Uint8Array([0, 255, 1]),
    });
  });
});
