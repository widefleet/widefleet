// Builds the app builder Worker: dist/builder.js and the WebAssembly modules it
// imports. The service documentation module comes from
// `cargo build --profile wasm -p platform-service-docs-wasm --target wasm32-wasip1`.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
]);
