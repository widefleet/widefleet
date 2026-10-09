import { readFileSync } from "node:fs";
import { z } from "zod";
import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const release = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")));

export default defineConfig({
  define: { "process.env.WIDEFLEET_BUILD_VERSION": JSON.stringify(release.version) },
  build: { sourcemap: "hidden" },
  plugins: [
    tailwindcss(),
    sveltekit({
      adapter: adapter(),
      experimental: { remoteFunctions: true },
      compilerOptions: { experimental: { async: true } },
    }),
  ],
});
