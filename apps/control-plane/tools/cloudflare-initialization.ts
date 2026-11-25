import { readFile } from "node:fs/promises";
import { unstable_readConfig } from "wrangler";
import { z } from "zod";
import { bootstrapConfiguration } from "@platform/contracts";
import { initializeBootstrap } from "../src/lib/server/bootstrap.ts";
import { migrateSsoSettings } from "../src/lib/server/sso-migration.ts";
import { createAuthentication, registerCli } from "../src/lib/server/auth.ts";
import type {
  CloudflareBindings,
  cloudflareConfigurationSchema,
} from "../src/lib/server/cloudflare-config.ts";
import type { Database } from "../src/lib/server/database.ts";
import {
  createInstallationOwner,
  initializeInstallation,
  readInstallation,
} from "../src/lib/server/installation-store.ts";
import type { Observation } from "../src/lib/server/observation.ts";
import { initializeCloudflareRuntime } from "../src/lib/server/organization-runtime.ts";
import { initializeOrganization } from "../src/lib/server/organization.ts";
import { configuredAppSignInOrganizations } from "../src/lib/server/settings.ts";
import { createSecretEncryption } from "../src/lib/server/secret-encryption.ts";
import { createCloudflareSettings } from "./cloudflare-settings.ts";
import { loadRuntimeExtension } from "./runtime-extension.ts";

export type InitializationPlatform = Pick<
  CloudflareBindings,
  "APP_RUNTIME" | "EMAIL" | "EMAIL_FROM"
>;

// Initializes a migrated database. The caller owns the platform bindings, so a
// deployment can reuse the connection it already opened for its runtime check.
export const initializeCloudflareInstallation = async ({
  configuration,
  database,
  observation,
  environment,
  configPath,
  secretsPath,
  bootstrapFile,
  platform,
}: {
  configuration: z.infer<typeof cloudflareConfigurationSchema>;
  database: Database;
  observation: Observation;
  environment: NodeJS.ProcessEnv;
  configPath: string;
  secretsPath: string | undefined;
  bootstrapFile: string | undefined;
  platform: () => Promise<InitializationPlatform>;
}) => {
  const execution = await initializeCloudflareRuntime(database);

  if (execution.isErr()) throw execution.error;
  await initializeOrganization(database);
  await initializeInstallation(database);

  const encryption = createSecretEncryption({ legacyKey: configuration.PLATFORM_ENCRYPTION_KEY });

  await migrateSsoSettings(database, encryption);
  await registerCli(database, configuration);

  const state = await readInstallation(database);

  let bootstrap: z.infer<typeof bootstrapConfiguration> | undefined;

  if (!state.ownerId || state.bootstrapPending) {
    if (!bootstrapFile)
      throw new Error("PLATFORM_BOOTSTRAP_FILE must provide the first hosted administrator");
    bootstrap = bootstrapConfiguration.parse(JSON.parse(await readFile(bootstrapFile, "utf8")));
  }

  const worker = z
    .object({
      send_email: z.array(z.object({ name: z.string() })),
      vars: z.record(z.string(), z.unknown()),
    })
    .parse(unstable_readConfig({ config: configPath }));

  const bindings = {
    ...environment,
    ...worker.vars,
    ...z
      .record(z.string(), z.string())
      .parse(secretsPath ? JSON.parse(await readFile(secretsPath, "utf8")) : {}),
  };

  const extension = await loadRuntimeExtension({
    configuration,
    database,
    observation,
    binding: (name, schema) => schema.parse(bindings[name]),
  });

  const emailSignIn =
    configuration.LOGIN_CODE_DELIVERY === "console" ||
    Boolean(extension.sendEmail) ||
    worker.send_email.some((binding) => binding.name === "EMAIL") ||
    Boolean(worker.vars["EMAIL_FROM"]);

  const publish = bootstrap
    ? Boolean(bootstrap.settings || emailSignIn || state.bootstrapPending)
    : (await configuredAppSignInOrganizations(database)).length > 0;

  if (publish) {
    const secrets = z.object({ APP_COOKIE_SECRET: z.string().min(1) }).parse(bindings);

    const services = createCloudflareSettings(
      configuration,
      database,
      encryption,
      secrets.APP_COOKIE_SECRET,
      await platform(),
      extension,
      observation,
    );

    if (bootstrap)
      await initializeBootstrap(
        services.settings,
        createAuthentication(configuration, database, { ...extension, observation, encryption }),
        database,
        bootstrap,
      );
    else await services.settings.republish();
  } else if (bootstrap) {
    await createInstallationOwner(database, bootstrap.owner, false, observation);
  }

  console.info("Hosted installation initialized");
};
