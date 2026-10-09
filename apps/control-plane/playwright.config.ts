import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://localhost:25430",
    trace: "retain-on-failure",
    // The local test client supplies the protocol header that the trusted TLS proxy sets in deployment.
    extraHTTPHeaders: { "x-forwarded-proto": "http" },
  },
  outputDir: "../../.local/playwright",
});
