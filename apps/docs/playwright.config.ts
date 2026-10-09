import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const port = process.env["DOCS_TEST_PORT"] ?? "14321";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  },
  outputDir: "../../.local/docs-playwright",
  webServer: {
    // The Worker preview uses dist; serve this test's isolated build directly.
    command: `pnpm --filter @platform/docs run build && node apps/docs/.blume-test/node_modules/astro/bin/astro.mjs preview --root apps/docs/.blume-test --host 127.0.0.1 --port ${port} --ignore-lock`,
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { DOCS_POSTHOG_KEY: "phc_docs_synthetic_verification", BLUME_RUNTIME_DIR: ".blume-test" },
    url: `http://127.0.0.1:${port}/docs`,
  },
});
