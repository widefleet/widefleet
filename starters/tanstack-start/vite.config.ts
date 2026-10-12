import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => {
  const buildId = process.env["WIDEFLEET_BUILD_ID"];

  if (command === "build" && !buildId)
    throw new Error("Run pnpm build to generate a shared build version.");

  return {
    define: {
      __WIDEFLEET_BUILD_ID__: JSON.stringify(buildId ?? "development"),
      "process.env.NODE_ENV": JSON.stringify(command === "build" ? "production" : "development"),
    },
    build: { sourcemap: true },
    environments: {
      client: { build: { outDir: "build/public" } },
      ssr: { build: { outDir: "build/server" } },
    },
    plugins: [
      cloudflare({
        viteEnvironment: { name: "ssr" },
        config: { main: "src/server.ts" },
      }),
      tanstackStart({
        router: {
          generatedRouteTree: fileURLToPath(
            new URL("./.platform/routeTree.gen.ts", import.meta.url),
          ),
        },
      }),
      react(),
      {
        name: "widefleet-build-version",
        generateBundle() {
          if (this.environment.name === "client")
            this.emitFile({
              type: "asset",
              fileName: "_widefleet/version.json",
              source: JSON.stringify({ version: buildId }),
            });
        },
      },
    ],
  };
});
