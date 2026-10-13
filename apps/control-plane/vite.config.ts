import { readFileSync } from "node:fs";
import { z } from "zod";
import adapter from "@sveltejs/adapter-node";
import cloudflare from "@sveltejs/adapter-cloudflare";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const release = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")));

export default defineConfig(({ mode }) => ({
  define: { "process.env.WIDEFLEET_BUILD_VERSION": JSON.stringify(release.version) },
  build: { sourcemap: "hidden" },
  plugins: [
    tailwindcss(),
    sveltekit({
      adapter: mode === "cloudflare" ? cloudflare({ config: "wrangler.jsonc" }) : adapter(),
      outDir: mode === "cloudflare" ? ".svelte-kit/cloudflare" : ".svelte-kit",
      files: {
        hooks: { server: mode === "cloudflare" ? "src/hooks.cloudflare" : "src/hooks.server" },
      },
      experimental: { remoteFunctions: true },
      compilerOptions: { experimental: { async: true } },
    }),
  ],
}));
