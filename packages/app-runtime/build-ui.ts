import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export const buildMcpUi = () =>
  build({
    configFile: false,
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [svelte(), tailwindcss()],
    ssr: { noExternal: true },
    build: {
      ssr: "src/ui/render.ts",
      outDir: "dist/mcp-ui",
      rollupOptions: { output: { entryFileNames: "index.js" } },
    },
  });
