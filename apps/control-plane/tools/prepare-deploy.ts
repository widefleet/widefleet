import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);

// Node can strip workspace TypeScript, but not TypeScript copied into node_modules by deploy.
const contractsDirectory = new URL("../../../packages/contracts/", import.meta.url);

const contractsManifest = new URL("package.json", contractsDirectory);

const contracts = z
  .object({ exports: z.object({ ".": z.string() }), files: z.array(z.string()).optional() })
  .passthrough()
  .parse(JSON.parse(await readFile(contractsManifest, "utf8")));

await build({
  entryPoints: [fileURLToPath(new URL("src/index.ts", contractsDirectory))],
  outfile: fileURLToPath(new URL("dist/index.js", contractsDirectory)),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});

contracts.exports["."] = "./dist/index.js";

contracts.files = ["dist", "src"];

await writeFile(contractsManifest, `${JSON.stringify(contracts, null, 2)}\n`);

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

await execute("pnpm", [
  "config",
  "--location",
  "project",
  "set",
  "patchedDependencies",
  JSON.stringify(patches),
  "--json",
]);
