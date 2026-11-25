import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGraphPicture,
  fetchPictureUrl,
  maxPictureBytes,
  pictureFormat,
} from "../src/lib/server/profile-picture.ts";

const png = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  return bytes;
};

describe("profile pictures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("recognizes raster pictures by their bytes only", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    expect(pictureFormat(png(16))).toBe("image/png");
    expect(pictureFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(pictureFormat(text("GIF89a..."))).toBe("image/gif");
    expect(pictureFormat(text("RIFF....WEBPVP8 "))).toBe("image/webp");
    expect(pictureFormat(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(pictureFormat(text("<html>"))).toBeNull();
  });

  it("reads a public picture within the size limit", async () => {
    vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"]);
    vi.spyOn(dns, "resolve6").mockResolvedValue([]);

    const responses = new Map([
      ["https://pictures.example.test/small", () => new Response(png(maxPictureBytes))],
      ["https://pictures.example.test/large", () => new Response(png(maxPictureBytes + 1))],
      ["https://pictures.example.test/gone", () => new Response(null, { status: 404 })],
      ["https://pictures.example.test/failing", () => new Response(null, { status: 503 })],
    ]);

    const requests: { url: string; redirect: RequestRedirect }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push({ url: request.url, redirect: request.redirect });

        return (responses.get(request.url) ?? (() => Response.error()))();
      }),
    );

    expect(await fetchPictureUrl("https://pictures.example.test/small")).toEqual({
      bytes: png(maxPictureBytes),
      contentType: "image/png",
    });
    expect(await fetchPictureUrl("https://pictures.example.test/large")).toBeNull();
    expect(await fetchPictureUrl("https://pictures.example.test/gone")).toBe("none");
    expect(await fetchPictureUrl("https://pictures.example.test/failing")).toBeNull();
    expect(await fetchPictureUrl("https://pictures.example.test/unreachable")).toBeNull();
    // A provider's redirect is not followed to another host.
    expect(requests.every((request) => request.redirect === "error")).toBe(true);
  });

  it("never requests a picture from a private network", async () => {
    vi.spyOn(dns, "resolve4").mockResolvedValue(["10.0.0.7"]);
    vi.spyOn(dns, "resolve6").mockResolvedValue([]);
    const request = vi.fn(async () => new Response(png(16)));
    vi.stubGlobal("fetch", request);

    expect(await fetchPictureUrl("https://intranet.example.test/photo")).toBeNull();
    expect(await fetchPictureUrl("https://127.0.0.1/photo")).toBeNull();
    expect(await fetchPictureUrl("https://user:secret@pictures.example.test/photo")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("asks Graph for the signed-in user's photo", async () => {
    let authorization: string | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://graph.microsoft.com/v1.0/me/photos/120x120/$value");
        authorization = request.headers.get("authorization");

        return new Response(png(32));
      }),
    );

    expect(await fetchGraphPicture("synthetic-access-token")).toEqual({
      bytes: png(32),
      contentType: "image/png",
    });
    expect(authorization).toBe("Bearer synthetic-access-token");
  });
});
