import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigFileTextToJson } from "typescript";
import { z } from "zod";
import { executionLimits } from "@platform/app-runtime/execution-limits";
import { runtimeConfigurationSchema } from "../src/lib/server/config.ts";
import type { Configuration } from "../src/lib/server/config.ts";

export const hostedInstallation = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    platformUrl: runtimeConfigurationSchema.shape.PLATFORM_URL,
    appDomain: z.hostname(),
    appZone: z.hostname(),
    queues: z.boolean().default(true),
    executionLimits: executionLimits.optional(),
    emailFrom: z.email().optional(),
    hyperdriveId: z.string().regex(/^[a-f0-9]{32}$/),
    // The database's cloud region, such as `aws:eu-central-1`. Each request makes several
    // queries in a row, so the control plane runs next to the database instead of the visitor.
    placementRegion: z
      .string()
      .regex(/^(aws|gcp|azure):[a-z0-9-]+$/)
      .optional(),
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
  // The app builder runs once per build phase, so each phase has its own isolate.
  builder: `${installation.name}-app-builder`,
  documenter: `${installation.name}-app-documenter`,
});

export const hostedResourceIds = z.object({
  account: z.string().regex(/^[a-f0-9]{32}$/),
  auth: z.string().regex(/^[a-f0-9]{32}$/),
});

interface HostedEmailBindings {
  send_email?: { name: string; allowed_sender_addresses: string[]; remote?: boolean }[];
}

export const hostedInitializationConfiguration = async (
  installation: z.infer<typeof hostedInstallation>,
  account: string,
) => {
  const email: HostedEmailBindings = {};
  const vars: Record<string, string> = {};

  if (installation.emailFrom) {
    email.send_email = [
      {
        name: "EMAIL",
        allowed_sender_addresses: [installation.emailFrom],
        remote: true,
      },
    ];
    vars["EMAIL_FROM"] = installation.emailFrom;
  }

  const control = await readWorkerConfiguration(fileURLToPath(new URL("../", import.meta.url)));

  return {
    name: `${installation.name}-initialize`,
    account_id: hostedResourceIds.shape.account.parse(account),
    compatibility_date: control.compatibility_date,
    services: [
      {
        binding: "APP_RUNTIME",
        service: hostedResourceNames(installation).runtime,
        entrypoint: "RuntimeManagement",
        remote: true,
      },
    ],
    ...email,
    vars,
  };
};

const readWorkerConfiguration = async (directory: string) => {
  const path = resolve(directory, "wrangler.jsonc");
  const parsed = parseConfigFileTextToJson(path, await readFile(path, "utf8"));

  if (parsed.error) throw new Error(`Invalid Wrangler configuration: ${path}`);

  const config = z
    .looseObject({
      main: z.string(),
      compatibility_date: z.string(),
      vars: z.record(z.string(), z.string()).default({}),
      assets: z.looseObject({ directory: z.string() }).optional(),
      workflows: z.array(z.looseObject({ name: z.string() })).default([]),
      base_dir: z.string().optional(),
      ratelimits: z
        .array(
          z.object({
            name: z.string(),
            namespace_id: z.string(),
            simple: z.object({
              limit: z.number(),
              period: z.union([z.literal(10), z.literal(60)]),
            }),
          }),
        )
        .optional(),
    })
    .parse(parsed.config);

  return {
    ...config,
    main: resolve(directory, config.main),
    base_dir: config.base_dir && resolve(directory, config.base_dir),
    $schema: undefined,
  };
};

export const hostedConfigurations = async (
  installation: z.infer<typeof hostedInstallation>,
  ids: z.infer<typeof hostedResourceIds>,
  loginCodeDelivery: Configuration["LOGIN_CODE_DELIVERY"] = "email",
  runtimeOverrides: Record<string, z.infer<ReturnType<typeof z.json>>> = {},
  controlOverrides: Record<string, z.infer<ReturnType<typeof z.json>>> = {},
) => {
  const names = hostedResourceNames(installation);
  const controlDirectory = fileURLToPath(new URL("../", import.meta.url));

  const runtimeDirectory = fileURLToPath(
    new URL("../../../packages/app-runtime/", import.meta.url),
  );

  const builderDirectory = fileURLToPath(
    new URL("../../../packages/app-builder/", import.meta.url),
  );

  const runtime = await readWorkerConfiguration(runtimeDirectory);
  const control = await readWorkerConfiguration(controlDirectory);
  const builder = await readWorkerConfiguration(builderDirectory);

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

  const emailBindings: HostedEmailBindings = {};
  const emailVariables: Record<string, string> = {};
  const executionVariables: Record<string, string> = {};
  executionVariables["WIDEFLEET_WORKLOAD_ISSUER"] =
    `https://auth.${installation.appDomain}/workload`;
  executionVariables["WIDEFLEET_MCP_ORIGIN"] = `https://mcp.${installation.appDomain}`;

  if (installation.executionLimits)
    executionVariables["WIDEFLEET_EXECUTION_LIMITS"] = JSON.stringify(installation.executionLimits);

  if (installation.emailFrom) {
    emailBindings.send_email = [
      { name: "EMAIL", allowed_sender_addresses: [installation.emailFrom] },
    ];
    emailVariables["EMAIL_FROM"] = installation.emailFrom;
  }

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
      ...runtimeOverrides,
      vars: {
        ...runtime.vars,
        ...z.record(z.string(), z.json()).optional().parse(runtimeOverrides["vars"]),
        ...executionVariables,
      },
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
      ratelimits: control.ratelimits?.map((binding) => ({
        ...binding,
        namespace_id: Number.parseInt(
          createHash("sha256")
            .update(`${names.controlPlane}:${binding.name}`)
            .digest("hex")
            .slice(0, 12),
          16,
        ).toString(),
      })),
      services: [
        service,
        { binding: "APP_BUILDER", service: names.builder },
        { binding: "APP_DOCUMENTER", service: names.documenter },
      ],
      ...emailBindings,
      hyperdrive: [{ binding: "HYPERDRIVE", id: installation.hyperdriveId }],
      kv_namespaces: [{ binding: "AUTH_CONFIG", id: ids.auth }],
      r2_buckets: [{ binding: "ARTIFACTS", bucket_name: names.artifacts }],
      ...(installation.placementRegion && { placement: { region: installation.placementRegion } }),
      ...controlOverrides,
      vars: {
        ...control.vars,
        APP_RUNTIME_NAME: names.runtime,
        CLOUDFLARE_ACCOUNT_ID: ids.account,
        PLATFORM_URL: installation.platformUrl,
        APP_DOMAIN: installation.appDomain,
        WIDEFLEET_QUEUES: String(installation.queues),
        LOGIN_CODE_DELIVERY: loginCodeDelivery,
        ...emailVariables,
        ...z.record(z.string(), z.json()).optional().parse(controlOverrides["vars"]),
      },
    },
    builder: { ...builder, account_id: ids.account, name: names.builder },
    documenter: { ...builder, account_id: ids.account, name: names.documenter },
    initialize: await hostedInitializationConfiguration(installation, ids.account),
  };
};
