import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "$app/server": "@sveltejs/kit/internal/server" } },
  test: { include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "examples/**/*.test.ts"] },
});
