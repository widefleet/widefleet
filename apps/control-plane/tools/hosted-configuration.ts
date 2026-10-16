import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigFileTextToJson } from "typescript";
import { z } from "zod";
import { runtimeConfigurationSchema } from "../src/lib/server/config.ts";

export const hostedInstallation = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    platformUrl: runtimeConfigurationSchema.shape.PLATFORM_URL,
    appDomain: z.hostname(),
    appZone: z.hostname(),
  })
  .refine(
    (value) => value.appDomain === value.appZone || value.appDomain.endsWith(`.${value.appZone}`),
    "The app domain must belong to the configured zone",
  );

export const readHostedInstallation = async (path: string) =>
  hostedInstallation.parse(JSON.parse(await readFile(path, "utf8")));

export const hostedResourceNames = (installation: z.infer<typeof hostedInstallation>) => ({
  runtime: `${installation.name}-app-runtime`,
  controlPlane: `${installation.name}-control-plane`,
  artifacts: `${installation.name}-artifacts`,
  auth: `${installation.name}-auth`,
  hyperdrive: `${installation.name}-postgres`,
});

export const hostedResourceIds = z.object({
  account: z.string().regex(/^[a-f0-9]{32}$/),
  auth: z.string().regex(/^[a-f0-9]{32}$/),
  hyperdrive: z.string().regex(/^[a-f0-9]{32}$/),
});

const readWorkerConfiguration = async (directory: string) => {
  const path = resolve(directory, "wrangler.jsonc");
  const parsed = parseConfigFileTextToJson(path, await readFile(path, "utf8"));

  if (parsed.error) throw new Error(`Invalid Wrangler configuration: ${path}`);

  const config = z
    .looseObject({
      main: z.string(),
      compatibility_date: z.string(),
      vars: z.record(z.string(), z.string()),
      assets: z.looseObject({ directory: z.string() }).optional(),
      workflows: z.array(z.looseObject({ name: z.string() })),
    })
    .parse(parsed.config);

  return { ...config, main: resolve(directory, config.main), $schema: undefined };
};

export const hostedConfigurations = async (
  installation: z.infer<typeof hostedInstallation>,
  ids: z.infer<typeof hostedResourceIds>,
) => {
  const names = hostedResourceNames(installation);
  const controlDirectory = fileURLToPath(new URL("../", import.meta.url));

  const runtimeDirectory = fileURLToPath(
    new URL("../../../packages/app-runtime/", import.meta.url),
  );

  const runtime = await readWorkerConfiguration(runtimeDirectory);
  const control = await readWorkerConfiguration(controlDirectory);

  const workflows = (base: typeof runtime) =>
    base.workflows.map((workflow) => ({
      ...workflow,
      name: workflow.name.replace(/^widefleet-/, `${installation.name}-`),
    }));

  const service = {
    binding: "APP_RUNTIME",
    service: names.runtime,
    entrypoint: "RuntimeManagement",
  };

  return {
    runtime: {
      ...runtime,
      account_id: ids.account,
      name: names.runtime,
      routes: [{ pattern: `*.${installation.appDomain}/*`, zone_name: installation.appZone }],
      kv_namespaces: [{ binding: "AUTH_CONFIG", id: ids.auth }],
      r2_buckets: [{ binding: "WIDEFLEET_PACKAGES", bucket_name: names.artifacts }],
      workflows: workflows(runtime),
      // Retain bindings provisioned by app deployments. This overrides Wrangler's
      // default keep_bindings, so secrets must be included explicitly as well.
      unsafe: {
        metadata: {
          keep_bindings: [
            "secret_text",
            "secret_key",
            "d1",
            "r2_bucket",
            "kv_namespace",
            "queue",
            "service",
          ],
        },
      },
      // Omit cron and queue-consumer declarations: app deployment owns them.
    },
    controlPlane: {
      ...control,
      account_id: ids.account,
      name: names.controlPlane,
      assets: {
        ...control.assets,
        directory: resolve(controlDirectory, z.string().parse(control.assets?.directory)),
      },
      routes: [{ pattern: new URL(installation.platformUrl).hostname, custom_domain: true }],
      workflows: workflows(control),
      services: [service],
      vars: {
        ...control.vars,
        APP_RUNTIME_NAME: names.runtime,
        CLOUDFLARE_ACCOUNT_ID: ids.account,
        PLATFORM_URL: installation.platformUrl,
        APP_DOMAIN: installation.appDomain,
      },
      hyperdrive: [{ binding: "HYPERDRIVE", id: ids.hyperdrive }],
      r2_buckets: [{ binding: "ARTIFACTS", bucket_name: names.artifacts }],
    },
    initialize: {
      name: `${installation.name}-initialize`,
      account_id: ids.account,
      compatibility_date: control.compatibility_date,
      services: [{ ...service, remote: true }],
    },
  };
};
