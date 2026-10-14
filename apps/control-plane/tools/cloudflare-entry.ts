import { rename, writeFile } from "node:fs/promises";

// Keep SvelteKit's generated fetch handler and add the deployment entrypoints in the same Worker.
await rename("dist/cloudflare/worker.js", "dist/cloudflare/application.js");

await writeFile(
  "dist/cloudflare/worker.js",
  `
import application from "./application.js";
import { scheduled } from "../../src/deployment-workflow.ts";
export { DeploymentWorkflow } from "../../src/deployment-workflow.ts";
export default { ...application, scheduled };
`,
);
