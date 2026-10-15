import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);

// Node can strip workspace TypeScript, but not TypeScript copied into node_modules by deploy.
for (const name of ["contracts", "auth-proxy"]) {
  const directory = new URL(`../../../packages/${name}/`, import.meta.url);
  const manifestPath = new URL("package.json", directory);

  const manifest = z
    .object({ exports: z.record(z.string(), z.string()), files: z.array(z.string()).optional() })
    .passthrough()
    .parse(JSON.parse(await readFile(manifestPath, "utf8")));

  const entryPoints = Object.fromEntries(
    Object.entries(manifest.exports).map(([name, source]) => [
      name === "." ? "index" : name.slice(2),
      fileURLToPath(new URL(source, directory)),
    ]),
  );

  await build({
    entryPoints,
    outdir: fileURLToPath(new URL("dist/", directory)),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  manifest.exports = Object.fromEntries(
    Object.keys(manifest.exports).map((name) => [
      name,
      `./dist/${name === "." ? "index" : name.slice(2)}.js`,
    ]),
  );
  manifest.files = ["dist", "src"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const docs = z
  .object({ dependencies: z.object({ blume: z.string() }) })
  .parse(JSON.parse(await readFile(new URL("../../docs/package.json", import.meta.url), "utf8")));

const patches = z
  .record(z.string(), z.string())
  .parse(
    JSON.parse((await execute("pnpm", ["config", "get", "patchedDependencies", "--json"])).stdout),
  );

// Blume belongs to documentation and is absent from the server dependency graph.
delete patches[`blume@${docs.dependencies.blume}`];

// Miniflare is used by Wrangler during development, not by the packaged server.
for (const name of Object.keys(patches)) {
  if (name.startsWith("miniflare@")) delete patches[name];
}

await execute("pnpm", [
  "config",
  "--location",
  "project",
  "set",
  "patchedDependencies",
  JSON.stringify(patches),
  "--json",
]);
