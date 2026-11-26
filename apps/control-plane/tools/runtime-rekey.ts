import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { z } from "zod";
import type { CloudflareBindings } from "../src/lib/server/cloudflare-config.ts";
import { runtimeConfigurationSchema } from "../src/lib/server/config.ts";
import { runtimeManagementRequest } from "../src/lib/server/runtime-management-node.ts";
import { rekeyRuntime, runtimeRekeyPath } from "../src/lib/server/runtime-rekey.ts";
import {
  hostedInitializationConfiguration,
  hostedResourceIds,
  readHostedInstallation,
} from "./hosted-configuration.ts";

// Usage: node tools/runtime-rekey.ts [<installation.json>]
// Seals runtime storage again under the active runtime key. With a Hosted
// installation file it reaches the runtime through Cloudflare, using
// CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Without one it runs inside the
// control-plane container of a self-hosted installation.
const installationPath = process.argv[2];

const rekeyHosted = async (path: string) => {
  const { CLOUDFLARE_ACCOUNT_ID } = z
    .object({
      CLOUDFLARE_ACCOUNT_ID: hostedResourceIds.shape.account,
      CLOUDFLARE_API_TOKEN: z.string().min(1),
    })
    .parse(process.env);

  const directory = await mkdtemp(join(tmpdir(), "widefleet-rekey-"));

  try {
    const configPath = join(directory, "wrangler.json");

    await writeFile(
      configPath,
      JSON.stringify(
        await hostedInitializationConfiguration(
          await readHostedInstallation(path),
          CLOUDFLARE_ACCOUNT_ID,
        ),
      ),
    );

    const proxy = await getPlatformProxy<Pick<CloudflareBindings, "APP_RUNTIME">>({
      configPath,
      persist: false,
    });

    try {
      const runtime = proxy.env.APP_RUNTIME;

      if (!runtime) throw new Error("App runtime is not configured");

      return await rekeyRuntime((body) =>
        runtime.fetch(`https://runtime.internal${runtimeRekeyPath}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
    } finally {
      await proxy.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const rekeySelfHosted = () => {
  const configuration = runtimeConfigurationSchema
    .pick({ PLATFORM_RUNTIME_DIRECTORY: true, PLATFORM_APP_RUNTIME_URL: true })
    .parse(process.env);

  return rekeyRuntime((body) =>
    runtimeManagementRequest(configuration, runtimeRekeyPath, "POST", body),
  );
};

const total = installationPath ? await rekeyHosted(installationPath) : await rekeySelfHosted();

console.info(JSON.stringify(total, null, 2));

if (total.unreadable > 0 || total.conflicts > 0) {
  console.error(
    total.unreadable > 0
      ? "Some runtime values could not be read. Keep earlier key versions, then run this again."
      : "Some runtime values changed during the run. Run this again.",
  );
  process.exitCode = 1;
}
