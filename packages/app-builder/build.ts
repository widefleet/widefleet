// Builds the app builder Worker: dist/builder.js and the WebAssembly modules it
// imports. The service documentation and app icon modules come from
// `cargo build --profile wasm -p platform-service-docs-wasm -p platform-app-icons-wasm --target wasm32-wasip1`.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseJsonc } from "./src/configuration.ts";

const directory = new URL("dist/", import.meta.url);

const path = (file: string) => fileURLToPath(new URL(file, directory).href);

await mkdir(path("."), { recursive: true });

await build({
  entryPoints: [new URL("src/worker.ts", import.meta.url).pathname],
  outfile: path("builder.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["module", "main"],
  target: "es2023",
  // The Worker imports its WebAssembly modules as compiled modules.
  external: ["cloudflare:*", "node:*", "*.wasm"],
  legalComments: "eof",
  logLevel: "warning",
});

await Promise.all([
  // The bundler imports esbuild's module next to its own entry.
  copyFile(
    fileURLToPath(new URL("esbuild.wasm", import.meta.resolve("@cloudflare/worker-bundler")).href),
    path("esbuild.wasm"),
  ),
  copyFile(
    fileURLToPath(
      new URL("../../target/wasm32-wasip1/wasm/platform_service_docs_wasm.wasm", import.meta.url)
        .href,
    ),
    path("service-docs.wasm"),
  ),
  copyFile(
    fileURLToPath(
      new URL("../../target/wasm32-wasip1/wasm/platform_app_icons_wasm.wasm", import.meta.url).href,
    ),
    path("app-icons.wasm"),
  ),
]);

// Self-hosted installations run dist/ as a celld project. celld accepts only
// the keys it implements, so it gets the Worker's name and compatibility.
const worker = z
  .object({ name: z.string(), compatibility_date: z.string() })
  .parse(
    parseJsonc(
      await readFile(fileURLToPath(new URL("wrangler.jsonc", import.meta.url).href), "utf8"),
      "wrangler.jsonc",
    ),
  );

await writeFile(
  path("wrangler.json"),
  `${JSON.stringify({ ...worker, main: "builder.js", no_bundle: true }, null, 2)}\n`,
);
