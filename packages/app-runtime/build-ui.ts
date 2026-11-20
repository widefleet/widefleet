import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL(".", import.meta.url));

export const buildMcpUi = () =>
  build({
    configFile: false,
    root,
    plugins: [svelte(), tailwindcss()],
    ssr: { noExternal: true },
    build: {
      ssr: "src/ui/render.ts",
      outDir: "dist/mcp-ui",
      rollupOptions: { output: { entryFileNames: "index.js" } },
    },
  });

const output = z.array(
  z.union([
    z.object({ type: z.literal("chunk"), isEntry: z.boolean(), code: z.string() }),
    z.object({ type: z.literal("asset"), fileName: z.string(), source: z.string() }),
  ]),
);

// MCP hosts load an app view as one HTML resource, so the form's script and
// styles are inlined into the page here rather than served as separate files.
export const buildInputForm = async () => {
  const result = z.object({ output }).parse(
    await build({
      configFile: false,
      root,
      logLevel: "warn",
      plugins: [svelte(), tailwindcss()],
      build: {
        write: false,
        modulePreload: false,
        cssCodeSplit: false,
        rollupOptions: { input: "src/ui/input-form/main.ts" },
      },
    }),
  ).output;

  const script = result.find((file) => file.type === "chunk" && file.isEntry);
  const styles = result.filter((file) => file.type === "asset" && file.fileName.endsWith(".css"));

  if (script?.type !== "chunk" || result.filter((file) => file.type === "chunk").length !== 1)
    throw new Error("The input form must build into one script");

  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    ...styles.map((file) => (file.type === "asset" ? `<style>${file.source}</style>` : "")),
    `</head><body><script type="module">${script.code.replaceAll("</script", "<\\/script")}</script></body></html>`,
  ].join("");

  const directory = new URL("dist/mcp-input-form/", import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL("index.js", directory),
    `export const inputFormHtml = ${JSON.stringify(html)};\n`,
  );
};
