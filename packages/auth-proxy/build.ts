import { build } from "esbuild";

await build({
  entryPoints: [new URL("src/worker.ts", import.meta.url).pathname],
  outfile: new URL("dist/worker.js", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  external: ["cloudflare:workers", "node:*"],
});
