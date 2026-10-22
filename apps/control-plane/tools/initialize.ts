import { fileURLToPath } from "node:url";
import { readConfiguration } from "../src/lib/server/config.ts";
import { initializeRuntime } from "../src/lib/server/runtime-initialization.ts";
import { loadRuntimeExtension } from "./runtime-extension.ts";

const runtime = await initializeRuntime(
  readConfiguration(),
  fileURLToPath(new URL("../migrations", import.meta.url)),
  loadRuntimeExtension,
);

await runtime.database.close();

console.info("Installation initialized");
