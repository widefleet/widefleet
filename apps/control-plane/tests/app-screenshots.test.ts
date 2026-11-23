import { describe, expect, it } from "vitest";
import {
  findAppScreenshot,
  maxScreenshotBytes,
  screenshotNumbers,
} from "../src/lib/server/app-screenshots.ts";

describe("app screenshot discovery", () => {
  const image = { hash: "a".repeat(32), size: 100 };

  it.each([
    ["/screenshots/1.png", 1, "image/png"],
    ["/screenshots/2.jpg", 2, "image/jpeg"],
    ["/screenshots/3.webp", 3, "image/webp"],
  ])("recognizes %s", (path, number, contentType) => {
    expect(findAppScreenshot({ [path]: image }, number)).toEqual({ ...image, contentType });
  });

  it("ignores other places, other formats, and empty or oversized files", () => {
    const manifest = {
      "/screenshots/1.svg": image,
      "/assets/screenshots/1.png": image,
      "/screenshots/2.png": { ...image, size: 0 },
      "/screenshots/3.png": { ...image, size: maxScreenshotBytes + 1 },
      "/screenshots/4.png": image,
    };

    expect(screenshotNumbers.filter((number) => findAppScreenshot(manifest, number))).toEqual([]);
  });
});
