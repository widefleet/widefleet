import { isAbsolute, resolve } from "node:path";
import { rename, writeFile } from "node:fs/promises";

const extension =
  process.env["WIDEFLEET_RUNTIME_EXTENSION"] ?? resolve("src/lib/server/runtime-extension.ts");

if (!isAbsolute(extension))
  throw new Error("WIDEFLEET_RUNTIME_EXTENSION must be an absolute module path");

// Keep SvelteKit's generated fetch handler and add the deployment entrypoints in the same Worker.
await rename("dist/cloudflare/worker.js", "dist/cloudflare/application.js");

await writeFile(
  "dist/cloudflare/worker.js",
  `
import application from "./application.js";
import { createRuntimeExtension } from ${JSON.stringify(extension)};
import { runScheduledExtension } from "../../src/lib/server/scheduled-extension.ts";
export { DeploymentWorkflow } from "../../src/deployment-workflow.ts";
export { AppOperationWorkflow } from "../../src/app-operation-workflow.ts";
export default {
  ...application,
  scheduled: (event, bindings) => runScheduledExtension(bindings, event, createRuntimeExtension),
};
`,
);
