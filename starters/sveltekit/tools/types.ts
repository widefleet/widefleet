import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";

await mkdir(new URL("../.platform", import.meta.url), { recursive: true });

const child = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["exec", "wrangler", "types", ".platform/worker-configuration.d.ts"],
  { stdio: "inherit" },
);

const [code] = z
  .tuple([z.number().nullable(), z.string().nullable()])
  .parse(await once(child, "exit"));

if (code !== 0) throw new Error("Wrangler type generation failed");
