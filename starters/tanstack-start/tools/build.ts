import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Vite can evaluate the configuration separately for its browser and Worker builds.
// Both bundles and the deployment manifest must retain the same version.
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./bin/vite.js", import.meta.resolve("vite/package.json"))), "build"],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production", WIDEFLEET_BUILD_ID: randomUUID() },
  },
);

const [code] = z
  .tuple([z.number().nullable(), z.string().nullable()])
  .parse(await once(child, "exit"));

if (code !== 0) throw new Error("App build failed");

// This upload exclusion file is specific to Wrangler; celld does not interpret it.
await rm(new URL("../build/public/.assetsignore", import.meta.url), { force: true });
