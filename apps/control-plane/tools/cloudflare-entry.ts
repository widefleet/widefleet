import { isAbsolute, resolve } from "node:path";
import { rename, writeFile } from "node:fs/promises";

const extension =
  process.env["WIDEFLEET_RUNTIME_EXTENSION"] ?? resolve("src/lib/server/runtime-extension.ts");

if (!isAbsolute(extension))
  throw new Error("WIDEFLEET_RUNTIME_EXTENSION must be an absolute module path");

const deploymentEntrypoint = process.env["WIDEFLEET_RUNTIME_EXTENSION"]
  ? `import { DeploymentWorkflow as BaseDeploymentWorkflow } from "../../src/deployment-workflow.ts";
import { observeDeploymentCompletion } from "../../src/lib/server/deployment-observation.ts";
export class DeploymentWorkflow extends BaseDeploymentWorkflow {
  observeCompletion(command, outcome) {
    return observeDeploymentCompletion(this.env, command, outcome, createRuntimeExtension);
  }
}`
  : 'export { DeploymentWorkflow } from "../../src/deployment-workflow.ts";';

// Keep SvelteKit's generated fetch handler and add the deployment entrypoints in the same Worker.
await rename("dist/cloudflare/worker.js", "dist/cloudflare/application.js");

await writeFile(
  "dist/cloudflare/worker.js",
  `
import application from "./application.js";
import { createRuntimeExtension } from ${JSON.stringify(extension)};
import { runScheduledExtension } from "../../src/lib/server/scheduled-extension.ts";
${deploymentEntrypoint}
export { AppOperationWorkflow } from "../../src/app-operation-workflow.ts";
export default {
  ...application,
  scheduled: (event, bindings) => runScheduledExtension(bindings, event, createRuntimeExtension),
};
`,
);
