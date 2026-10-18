import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

it("loads the Cloudflare provisioning entry with Node's native TypeScript support", async () => {
  await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("../src/lib/server/cloudflare-provisioning.ts", import.meta.url))],
    { env: { ...process.env, NODE_OPTIONS: "" }, timeout: 10_000 },
  );
});
