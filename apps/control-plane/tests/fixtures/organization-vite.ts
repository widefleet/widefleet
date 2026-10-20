import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      outDir: ".svelte-kit/organization-tests",
      files: { hooks: { server: "tests/fixtures/organization-hooks" } },
      experimental: { remoteFunctions: true },
      compilerOptions: { experimental: { async: true } },
    }),
  ],
});
