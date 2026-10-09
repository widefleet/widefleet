import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { z } from "zod";

await mkdir(new URL("../.platform", import.meta.url), { recursive: true });

const manifest = new URL(import.meta.resolve("wrangler/package.json"));

const { bin } = z
  .object({ bin: z.object({ wrangler: z.string() }) })
  .parse(JSON.parse(await readFile(manifest, "utf8")));

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL(bin.wrangler, manifest)), "types", ".platform/worker-configuration.d.ts"],
  { stdio: "inherit" },
);

const [code] = z
  .tuple([z.number().nullable(), z.string().nullable()])
  .parse(await once(child, "exit"));

if (code !== 0) throw new Error("Wrangler type generation failed");
