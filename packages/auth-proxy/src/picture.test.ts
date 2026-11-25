import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGraphPicture,
  fetchPictureUrl,
  maxPictureBytes,
  pictureFormat,
  pictureStore,
  type PictureResult,
  type PictureStorage,
} from "./picture.ts";

const png = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  return bytes;
};

const provider = "https://login.example.test";

describe("profile pictures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("asks only the provider and Google's picture host, within the size limit", async () => {
    const responses = new Map([
      [`${provider}/small`, () => new Response(png(maxPictureBytes))],
      [`${provider}/large`, () => new Response(png(maxPictureBytes + 1))],
      [`${provider}/gone`, () => new Response(null, { status: 404 })],
      [`${provider}/failing`, () => new Response(null, { status: 503 })],
      [
        `${provider}/moved`,
        () => new Response(null, { status: 302, headers: { location: `${provider}/small` } }),
      ],
      ["https://lh3.googleusercontent.com/a/photo", () => new Response(png(32))],
    ]);

    const requests: { url: string; redirect: RequestRedirect; authorization: string | null }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);

        requests.push({
          url: request.url,
          redirect: request.redirect,
          authorization: request.headers.get("authorization"),
        });

        return (responses.get(request.url) ?? (() => Response.error()))();
      }),
    );

    const read = (url: string) => fetchPictureUrl(new URL(url), provider, "provider-token");

    expect(await read(`${provider}/small`)).toEqual({
      bytes: png(maxPictureBytes),
      contentType: "image/png",
    });
    expect(await read(`${provider}/large`)).toBeNull();
    expect(await read(`${provider}/gone`)).toBe("none");
    expect(await read(`${provider}/failing`)).toBeNull();
    // A redirect is not followed: it reads as no picture available right now.
    expect(await read(`${provider}/moved`)).toBeNull();
    // Without the sign-in's token the provider is not asked.
    expect(await fetchPictureUrl(new URL(`${provider}/small`), provider, undefined)).toBeNull();
    expect(await read("https://lh3.googleusercontent.com/a/photo")).toEqual({
      bytes: png(32),
      contentType: "image/png",
    });
    // Other hosts, including private ones, are never asked.
    expect(await read("https://pictures.example.test/photo")).toBeNull();
    expect(await read("http://lh3.googleusercontent.com/a/photo")).toBeNull();
    expect(await read("https://10.0.0.7/photo")).toBeNull();
    expect(await read("https://user:secret@login.example.test/small")).toBeNull();

    expect(requests.map(({ url }) => url)).toEqual([
      `${provider}/small`,
      `${provider}/large`,
      `${provider}/gone`,
      `${provider}/failing`,
      `${provider}/moved`,
      "https://lh3.googleusercontent.com/a/photo",
    ]);
    // The provider's token goes only to the provider, and no redirect is followed.
    expect(requests.at(-1)?.authorization).toBeNull();
    expect(
      requests.slice(0, 5).every((request) => request.authorization === "Bearer provider-token"),
    ).toBe(true);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
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

  it("asks the provider at most once a day, whatever it answers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const entries = new Map<string, { value: ArrayBuffer; metadata: unknown }>();

    const storage: PictureStorage = {
      getWithMetadata: async (key) => entries.get(key) ?? { value: null, metadata: null },
      put: async (key, value, options) => {
        entries.set(key, { value: value.slice().buffer, metadata: options.metadata });
      },
    };

    const store = pictureStore(storage, "organization", "https://login.example.test");
    const asked: PictureResult[] = [];

    const refresh = (answer: PictureResult) =>
      store.refresh("person", async () => {
        asked.push(answer);

        return answer;
      });

    const day = 24 * 60 * 60 * 1000;
    const picture = { bytes: png(16), contentType: "image/png" };

    try {
      const version = await refresh(picture);
      expect(version).toMatch(/^[0-9a-f]{16}$/);
      expect(await store.read("person")).toMatchObject({ version, contentType: "image/png" });

      // Within a day the copy answers without asking.
      expect(await refresh("none")).toBe(version);
      // A failure keeps the copy and waits another day.
      vi.setSystemTime(Date.now() + day);
      expect(await refresh(null)).toBe(version);
      expect(await refresh("none")).toBe(version);
      // A provider that reports no picture removes it, and is not asked again that day.
      vi.setSystemTime(Date.now() + day);
      expect(await refresh("none")).toBeUndefined();
      expect(await store.read("person")).toBeNull();
      expect(await refresh(picture)).toBeUndefined();
      expect(asked).toEqual([picture, null, "none"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares a refresh between parallel renewals and keeps the copy when a write fails", async () => {
    const entries = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
    let failWrites = false;

    const storage: PictureStorage = {
      getWithMetadata: async (key) => entries.get(key) ?? { value: null, metadata: null },
      put: async (key, value, options) => {
        if (failWrites) throw new Error("KV write limit");
        entries.set(key, { value: value.slice().buffer, metadata: options.metadata });
      },
    };

    const store = pictureStore(storage, "organization", "https://login.example.test");
    let asked = 0;

    const answer = (picture: PictureResult) => async () => {
      asked += 1;

      return picture;
    };

    const picture = { bytes: png(16), contentType: "image/png" };

    const versions = await Promise.all([
      store.refresh("person", answer(picture)),
      store.refresh("person", answer(picture)),
    ]);

    expect(asked).toBe(1);
    expect(versions[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(versions[1]).toBe(versions[0]);

    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
      failWrites = true;
      expect(
        await store.refresh("person", answer({ bytes: png(24), contentType: "image/png" })),
      ).toBe(versions[0]);
    } finally {
      vi.useRealTimers();
    }
  });
});
