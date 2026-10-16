import { spawn } from "node:child_process";
import { deployWithIndexNow } from "./indexnow.ts";

if (process.argv.length > 2) {
  throw new Error(
    "This production deploy script takes no arguments. Use deploy:preview for Previews.",
  );
}

const key = process.env["INDEXNOW_KEY"];

if (!key || !/^[a-zA-Z0-9-]{8,128}$/.test(key)) {
  throw new Error("Set INDEXNOW_KEY as a Cloudflare build secret before deploying production.");
}

// Preview deployments use their separate package script and never run this file.
await deployWithIndexNow(
  {
    sitemapFile: new URL("../.wrangler/docs-assets/docs/sitemap.xml", import.meta.url),
    sitemapUrl: "https://widefleet.com/docs/sitemap.xml",
    scope: "docs",
    key,
    endpoint: "https://www.bing.com/indexnow",
  },
  () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn("wrangler", ["deploy"], { stdio: "inherit" });

      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Wrangler deploy failed (${signal ?? code}).`));
      });
    }),
);
