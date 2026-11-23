import type { assetManifest } from "@platform/contracts";
import type { z } from "zod";

// An app shows itself with up to three pictures among its static assets, such as
// `/screenshots/1.png`. Like its icon, they come with a deployment and need no upload.
export const screenshotNumbers = [1, 2, 3] as const;

const screenshotTypes = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["webp", "image/webp"],
]);

export const maxScreenshotBytes = 2 * 1024 * 1024;

export const findAppScreenshot = (manifest: z.infer<typeof assetManifest>, number: number) => {
  for (const [extension, contentType] of screenshotTypes) {
    const entry = manifest[`/screenshots/${number}.${extension}`];

    if (entry && entry.size > 0 && entry.size <= maxScreenshotBytes)
      return { ...entry, contentType };
  }

  return null;
};
