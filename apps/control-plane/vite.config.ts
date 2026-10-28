import { isAbsolute } from "node:path";
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

const clientExtension = process.env["WIDEFLEET_AUTH_CLIENT_EXTENSION"];

if (clientExtension && !isAbsolute(clientExtension))
  throw new Error("WIDEFLEET_AUTH_CLIENT_EXTENSION must be an absolute module path");

const extension = process.env["WIDEFLEET_RUNTIME_EXTENSION"];

if (extension && !isAbsolute(extension))
  throw new Error("WIDEFLEET_RUNTIME_EXTENSION must be an absolute module path");

const aliases: Record<string, string> = {};

if (extension) aliases["#runtime-extension"] = extension;

if (clientExtension) aliases["#auth-client-extension"] = clientExtension;

export const controlPlaneConfig = (target: "node" | "cloudflare") =>
  defineConfig({
    resolve: { alias: aliases },
    define: { "process.env.WIDEFLEET_BUILD_VERSION": JSON.stringify(release.version) },
    build: { sourcemap: "hidden" },
    plugins: [
      tailwindcss(),
      sveltekit({
        adapter: target === "cloudflare" ? cloudflare({ config: "wrangler.jsonc" }) : adapter(),
        outDir: target === "cloudflare" ? ".svelte-kit/cloudflare" : ".svelte-kit",
        files: {
          hooks: { server: target === "cloudflare" ? "src/hooks.cloudflare" : "src/hooks.server" },
        },
        experimental: { remoteFunctions: true },
        compilerOptions: { experimental: { async: true } },
      }),
    ],
  });

export default controlPlaneConfig("node");
