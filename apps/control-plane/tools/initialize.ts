import { fileURLToPath } from "node:url";
import { readConfiguration } from "../src/lib/server/config.ts";
import { initializeRuntime } from "../src/lib/server/runtime-initialization.ts";
import { loadRuntimeExtension } from "./runtime-extension.ts";
import { closeObservation } from "../src/lib/server/observation.ts";

const runtime = await initializeRuntime(
  readConfiguration(),
  fileURLToPath(new URL("../migrations", import.meta.url)),
  loadRuntimeExtension,
);

try {
  await closeObservation(runtime.observation);
} finally {
  await runtime.database.close();
}

console.info("Installation initialized");
