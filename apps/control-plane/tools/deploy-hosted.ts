import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Result } from "better-result";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { bootstrapConfiguration, runtimeRelease } from "@platform/contracts";
import { getPlatformProxy } from "wrangler";
import { z } from "zod";
import { cloudflareConfigurationSchema } from "../src/lib/server/cloudflare-config.ts";
import type { CloudflareBindings } from "../src/lib/server/cloudflare-config.ts";
import { createCloudflareProvisioner } from "../src/lib/server/cloudflare-provisioning.ts";
import {
  readCloudflareRuntimeVersion,
  validateCloudflareRuntime,
} from "../src/lib/server/cloudflare-runtime-package.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { initializeCloudflareRuntime } from "../src/lib/server/organization-runtime.ts";
import { initializeInstallation, readInstallation } from "../src/lib/server/installation-store.ts";
import { StorageUnavailable } from "../src/lib/server/errors.ts";
import {
  hostedConfigurations,
  hostedResourceIds,
  hostedResourceNames,
  readHostedInstallation,
} from "./hosted-configuration.ts";
import { provisionHostedResources } from "./hosted-resources.ts";
import { deployHostedRuntime } from "./hosted-runtime.ts";

const execute = promisify(execFile);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "runtime-config": { type: "string" }, "control-config": { type: "string" } },
});

if (positionals.length !== 1)
  throw new Error(
    "Usage: node tools/deploy-hosted.ts <installation.json> [--runtime-config <file.json>] [--control-config <file.json>]",
  );

const installation = await readHostedInstallation(z.string().parse(positionals[0]));

const names = hostedResourceNames(installation);

const secrets = z
  .object({
    CLOUDFLARE_ACCOUNT_ID: hostedResourceIds.shape.account,
    CLOUDFLARE_API_TOKEN: z.string().min(1),
    WIDEFLEET_PROVISIONING_TOKEN: z.string().min(1),
    DATABASE_URL: z
      .url()
      .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol)),
    BETTER_AUTH_SECRET: z.string().min(32),
    PLATFORM_ENCRYPTION_KEY: z.string().min(32),
    WIDEFLEET_CONTROL_TOKEN: z.string().min(32),
    WIDEFLEET_CONNECTOR_KEY: z.string().regex(/^[a-f0-9]{64}$/),
    APP_COOKIE_SECRET: z.string().min(32),
    PLATFORM_BOOTSTRAP: z
      .string()
      .optional()
      .transform((value) => value || undefined),
  })
  .parse(process.env);

// A trusted installation may supply additional Wrangler configuration.
const runtimeOverrides = z
  .record(z.string(), z.json())
  .parse(
    values["runtime-config"]
      ? JSON.parse(await readFile(resolve(values["runtime-config"]), "utf8"))
      : {},
  );

const controlOverrides = z
  .record(z.string(), z.json())
  .parse(
    values["control-config"]
      ? JSON.parse(await readFile(resolve(values["control-config"]), "utf8"))
      : {},
  );

const bootstrap = secrets.PLATFORM_BOOTSTRAP
  ? bootstrapConfiguration.parse(JSON.parse(secrets.PLATFORM_BOOTSTRAP))
  : undefined;

const configuration = cloudflareConfigurationSchema.parse({
  ...secrets,
  PLATFORM_URL: installation.platformUrl,
  APP_DOMAIN: installation.appDomain,
  LOGIN_CODE_DELIVERY: process.env["LOGIN_CODE_DELIVERY"],
  PLATFORM_USAGE_REPORTING: "false",
  PLATFORM_CRASH_REPORTING: "false",
});

const { default: bundled } = await import("@platform/app-runtime/release", {
  with: { type: "json" },
});

const release = runtimeRelease.parse(bundled);

validateCloudflareRuntime(release);

const controlDirectory = fileURLToPath(new URL("../", import.meta.url));

const generatedDirectory = resolve(controlDirectory, ".wrangler/hosted");

await mkdir(generatedDirectory, { recursive: true, mode: 0o700 });

const directory = await mkdtemp(resolve(generatedDirectory, `${installation.name}-`));

const database = createDatabase(configuration);

const cloudflare = createCloudflareProvisioner({
  accountId: secrets.CLOUDFLARE_ACCOUNT_ID,
  token: secrets.CLOUDFLARE_API_TOKEN,
  runtimeName: names.runtime,
});

const childEnvironment = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_API_TOKEN,
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
};

const password = decodeURIComponent(new URL(secrets.DATABASE_URL).password);

const sensitive = [...Object.values(secrets), password].flatMap((value) =>
  value ? [value, JSON.stringify(value).slice(1, -1)] : [],
);

const redact = (output: string) => {
  for (const value of sensitive) output = output.replaceAll(value, "[REDACTED]");

  return output;
};

const run = async (
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = childEnvironment,
) => {
  const result = await Result.tryPromise(() =>
    execute(command, args, {
      cwd: controlDirectory,
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
    }),
  );

  if (result.isErr()) {
    const output = z
      .object({ stdout: z.string(), stderr: z.string() })
      .safeParse(result.error.cause);

    if (output.success) console.error(redact(`${output.data.stdout}\n${output.data.stderr}`));
    // execFile's error message includes argv, which may contain sensitive values.
    throw new Error(`${command} failed; see the sanitized command output above`);
  }

  console.info(redact(result.value.stdout));

  if (result.value.stderr) console.error(redact(result.value.stderr));
};

const write = async (name: string, contents: string) => {
  const path = resolve(directory, name);
  await writeFile(path, contents, { mode: 0o600 });

  return path;
};

try {
  console.info(`Preparing Hosted installation ${installation.name}`);
  await migrate(database.db, { migrationsFolder: resolve(controlDirectory, "migrations") });
  const initialized = await initializeCloudflareRuntime(database.db);

  if (initialized.isErr()) throw initialized.error;
  await initializeInstallation(database.db);

  if (!(await readInstallation(database.db)).ownerId && !bootstrap)
    throw new Error("PLATFORM_BOOTSTRAP must provide the first Hosted administrator");

  // Provisioning commands only need the account, not a Worker's template config.
  const accountConfig = await write(
    "account.json",
    JSON.stringify({ account_id: secrets.CLOUDFLARE_ACCOUNT_ID }),
  );

  const wrangler = (args: string[]) =>
    run("pnpm", ["exec", "wrangler", ...args, "--config", accountConfig]);

  const ids = hostedResourceIds.parse({
    account: secrets.CLOUDFLARE_ACCOUNT_ID,
    ...(await provisionHostedResources(installation, cloudflare, wrangler)),
  });

  const configs = await hostedConfigurations(
    installation,
    ids,
    configuration.LOGIN_CODE_DELIVERY,
    runtimeOverrides,
    controlOverrides,
  );

  const runtimeConfig = await write("runtime.json", JSON.stringify(configs.runtime));
  const controlConfig = await write("control-plane.json", JSON.stringify(configs.controlPlane));
  const initializeConfig = await write("initialize.json", JSON.stringify(configs.initialize));

  const runtimeSecrets = await write(
    "runtime-secrets.json",
    JSON.stringify({
      WIDEFLEET_CONTROL_TOKEN: secrets.WIDEFLEET_CONTROL_TOKEN,
      WIDEFLEET_CONNECTOR_KEY: secrets.WIDEFLEET_CONNECTOR_KEY,
    }),
  );

  const controlSecrets = await write(
    "control-secrets.json",
    JSON.stringify({
      BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET,
      PLATFORM_ENCRYPTION_KEY: secrets.PLATFORM_ENCRYPTION_KEY,
      APP_COOKIE_SECRET: secrets.APP_COOKIE_SECRET,
      CLOUDFLARE_API_TOKEN: secrets.WIDEFLEET_PROVISIONING_TOKEN,
    }),
  );

  await deployHostedRuntime(
    database.db,
    cloudflare,
    {
      put: (key, bytes, contentType) =>
        Result.tryPromise({
          try: async () => {
            const path = resolve(directory, "release.json");
            await writeFile(path, bytes, { mode: 0o600 });
            await wrangler([
              "r2",
              "object",
              "put",
              `${names.artifacts}/${key}`,
              "--file",
              path,
              "--content-type",
              contentType,
              "--remote",
            ]);
          },
          catch: (cause) =>
            new StorageUnavailable({ message: "Could not save the Runtime release", cause }),
        }),
    },
    release,
    async (confirmedBindingTag) => {
      await run("pnpm", [
        "exec",
        "wrangler",
        "deploy",
        "--config",
        runtimeConfig,
        "--secrets-file",
        runtimeSecrets,
        ...(confirmedBindingTag ? ["--tag", confirmedBindingTag] : []),
      ]);

      const proxy = await getPlatformProxy<Pick<CloudflareBindings, "APP_RUNTIME">>({
        configPath: initializeConfig,
        persist: false,
      });

      try {
        if ((await readCloudflareRuntimeVersion(proxy.env)) !== release.version)
          throw new Error("The requested Runtime version is not active");
      } finally {
        await proxy.dispose();
      }
    },
  );

  const bootstrapFile = bootstrap
    ? await write("bootstrap.json", JSON.stringify(bootstrap))
    : undefined;

  await run(process.execPath, ["tools/initialize-cloudflare.ts"], {
    ...childEnvironment,
    PLATFORM_URL: installation.platformUrl,
    APP_DOMAIN: installation.appDomain,
    LOGIN_CODE_DELIVERY: configs.controlPlane.vars.LOGIN_CODE_DELIVERY,
    PLATFORM_USAGE_REPORTING: "false",
    PLATFORM_CRASH_REPORTING: "false",
    WIDEFLEET_INITIALIZE_CONFIG: initializeConfig,
    PLATFORM_BOOTSTRAP_FILE: bootstrapFile,
  });
  await run("pnpm", [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    controlConfig,
    "--secrets-file",
    controlSecrets,
  ]);
  console.info(`Hosted installation deployed: ${installation.platformUrl}`);
} finally {
  await database.close();
  await rm(directory, { recursive: true, force: true });
}
