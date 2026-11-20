import { describe, expect, it } from "vitest";
import { hashAsset } from "../src/lib/server/asset-hash.ts";
import { templateProject } from "../src/lib/server/template-project.ts";

const encoder = new TextEncoder();

const icon = Uint8Array.from([0, 159, 146, 150, 255]);

type Assets = { directory: string; binding: string } | undefined;

const project = (assets: Assets, extra: Record<string, Uint8Array> = {}) => ({
  "wrangler.jsonc": encoder.encode(
    `// A comment, as in templates.\n${JSON.stringify({ main: "src/app.ts", assets })}`,
  ),
  "src/app.ts": encoder.encode("export default {};\n"),
  ...extra,
});

describe("template projects", () => {
  it("separates static assets from the sources the builder bundles", () => {
    const result = templateProject(
      project(
        { directory: "./public/", binding: "STATIC" },
        { "public/favicon.png": icon, "public/nested/copy.png": icon },
      ),
    ).unwrap();

    expect(Object.keys(result.sources).sort()).toEqual(["src/app.ts", "wrangler.jsonc"]);
    expect(result.assets.binding).toBe("STATIC");

    // Binary bytes stay intact, and identical files are stored once.
    const hash = hashAsset("/favicon.png", icon);
    expect(result.assets.manifest).toEqual({
      "/favicon.png": { hash, size: icon.byteLength },
      "/nested/copy.png": { hash: hashAsset("/nested/copy.png", icon), size: icon.byteLength },
    });
    expect(result.assets.bytes.get(hash)).toEqual(icon);
  });

  it("bundles every file of a template without static assets", () => {
    const result = templateProject(project(undefined, { "public/favicon.png": icon })).unwrap();

    expect(Object.keys(result.sources)).toContain("public/favicon.png");
    expect(result.assets).toMatchObject({ binding: "ASSETS", manifest: {} });
  });

  it.each([
    [{ directory: "../shared", binding: "ASSETS" }, {}, "must be inside the template"],
    [{ directory: ".", binding: "ASSETS" }, {}, "must be inside the template"],
    [
      { directory: "public", binding: "ASSETS" },
      { "public/.assetsignore": encoder.encode("*.map") },
      "ignore rules are not supported",
    ],
    [
      { directory: "public", binding: "ASSETS" },
      { "public/app.js.map": encoder.encode("{}") },
      "Source maps in static assets",
    ],
    [
      { directory: "public", binding: "ASSETS" },
      { "public/large.bin": new Uint8Array(25 * 1024 * 1024 + 1) },
      "exceeds 25 MiB",
    ],
  ])("rejects unsupported static assets: %j", (assets, extra, message) => {
    const result = templateProject(project(assets, extra));

    expect(result.isErr() && result.error.message).toContain(message);
  });
});
