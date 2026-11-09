import { describe, expect, it } from "vitest";
import { findAppIcon } from "../src/lib/server/app-icons.ts";

describe("app icon discovery", () => {
  const icon = { hash: "a".repeat(32), size: 100 };

  it("prefers SVG over ICO and touch icons", () => {
    expect(
      findAppIcon({
        "/apple-touch-icon.png": icon,
        "/assets/favicon-a123.svg": icon,
        "/favicon.ico": icon,
        "/favicon.svg": icon,
      }),
    ).toEqual({ ...icon, contentType: "image/svg+xml" });
  });

  it.each([
    "/assets/favicon-a123.svg",
    "/_app/immutable/assets/favicon.a123.svg",
    "/icons/favicon.svg",
  ])("ignores favicons outside the known root paths: %s", (path) => {
    expect(findAppIcon({ [path]: icon })).toBeNull();
  });

  it.each([
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon.ico", "image/x-icon"],
    ["/favicon.png", "image/png"],
    ["/apple-touch-icon.png", "image/png"],
  ])("recognizes the known path %s", (path, contentType) => {
    expect(findAppIcon({ [path]: icon })).toEqual({ ...icon, contentType });
  });

  it("skips oversized and empty files and ignores unrelated assets", () => {
    expect(
      findAppIcon({
        "/favicon.svg": { hash: "b".repeat(32), size: 256 * 1024 + 1 },
        "/favicon.ico": { hash: "c".repeat(32), size: 0 },
        "/favicon.png": icon,
      }),
    ).toEqual({ ...icon, contentType: "image/png" });
    expect(
      findAppIcon({ "/index.html": icon, "/secret.svg": icon, "/favicon.js": icon }),
    ).toBeNull();
    expect(findAppIcon({})).toBeNull();
  });
});
