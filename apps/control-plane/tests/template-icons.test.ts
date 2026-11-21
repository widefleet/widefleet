import { afterEach, describe, expect, it, vi } from "vitest";
import { maxIconBytes } from "../src/lib/server/app-icons.ts";
import { readTemplateIcon } from "../src/lib/server/app-templates.ts";

const encoder = new TextEncoder();

const base = "https://raw.githubusercontent.com/widefleet/widefleet/main/templates/notes/";

/** Serves a template's files from main and records which downloads were cancelled. */
const repository = (files: Record<string, Uint8Array>) => {
  const downloaded: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = (input instanceof Request ? input.url : input.toString()).slice(base.length);
    const content = files[path];

    if (!content) return new Response(null, { status: 404 });

    // One chunk per KiB, so a read that stops early leaves the stream unfinished.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < content.byteLength; offset += 1024)
          controller.enqueue(content.slice(offset, offset + 1024));

        controller.close();
      },
      cancel() {
        downloaded.push(`${path} (cancelled)`);
      },
    });

    downloaded.push(path);

    return new Response(body);
  });

  return downloaded;
};

const wrangler = encoder.encode(
  `// As in templates.\n${JSON.stringify({ assets: { directory: "./public", binding: "ASSETS" } })}`,
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("template icons", () => {
  it("reads the icon of a template configured with wrangler.json", async () => {
    const icon = encoder.encode("<svg/>");
    repository({ "wrangler.json": wrangler, "public/favicon.svg": icon });

    expect((await readTemplateIcon("notes")).unwrap()).toEqual({
      bytes: icon,
      contentType: "image/svg+xml",
    });
  });

  it("stops downloading an oversized icon and uses the next one", async () => {
    const icon = encoder.encode("png");

    const downloaded = repository({
      "wrangler.jsonc": wrangler,
      "public/favicon.svg": new Uint8Array(maxIconBytes + 4096),
      "public/favicon.png": icon,
    });

    expect((await readTemplateIcon("notes")).unwrap()).toEqual({
      bytes: icon,
      contentType: "image/png",
    });
    expect(downloaded).toContain("public/favicon.svg (cancelled)");
  });

  it("has no icon when the asset settings are invalid", async () => {
    repository({
      "wrangler.jsonc": encoder.encode(
        JSON.stringify({ assets: { directory: "public", binding: "STATIC-FILES" } }),
      ),
      "public/favicon.svg": encoder.encode("<svg/>"),
    });

    expect((await readTemplateIcon("notes")).isErr()).toBe(true);
  });
});
