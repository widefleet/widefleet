import * as contract from "@platform/contracts";
import { z } from "zod";
import { InvalidOperation } from "./errors.ts";
import {
  cloudflareResourceName,
  type createCloudflareProvisioner,
} from "./cloudflare-provisioning.ts";
import { verifyModules } from "./package-storage.ts";

export const hostedSecretBytes = 5_000;

const wrapperName = "__widefleet_connector__.mjs";

export const connectorWorkerName = (fleetId: string, name: string) =>
  cloudflareResourceName(fleetId, "connector", name);

export const connectorServiceBinding = (fleetId: string, name: string, entrypoint: string) => ({
  type: "service" as const,
  name: `C_${cloudflareResourceName(fleetId, name, entrypoint)}`,
  service: connectorWorkerName(fleetId, name),
  entrypoint: entrypoint === "default" ? "WIDEFLEET_CONNECTOR" : entrypoint,
});

export const validateHostedSecret = (value: string) => {
  if (new TextEncoder().encode(value).byteLength > hostedSecretBytes)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Hosted connector secrets must contain at most 5 KB (5000 UTF-8 bytes)",
    });
};

export const validateHostedConnector = (
  release: z.infer<typeof contract.connectorPackage>,
  secretNames: string[],
) => {
  verifyModules(release);
  const configuration = release.configuration;

  if (release.modules.some((module) => module.name === wrapperName))
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Connector module name is reserved",
    });

  if (Object.keys(configuration.vars).length + secretNames.length > 128)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Hosted connectors support at most 128 variables and secrets combined",
    });

  for (const value of Object.values(configuration.vars))
    if (new TextEncoder().encode(value).byteLength > hostedSecretBytes)
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Hosted connector variables must contain at most 5 KB (5000 UTF-8 bytes)",
      });
  const tags = configuration.migrations.map((migration) => migration.tag);
  const classes = configuration.migrations.flatMap((migration) => migration.new_sqlite_classes);

  if (new Set(tags).size !== tags.length || new Set(classes).size !== classes.length)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message:
        "Connector migrations must have unique tags and introduce each Durable Object class once",
    });

  if (
    configuration.durable_objects.bindings.some((binding) => !classes.includes(binding.class_name))
  )
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Every connector Durable Object class requires a SQLite migration",
    });
};

export const connectorWorkerModules = (release: z.infer<typeof contract.connectorPackage>) => [
  ...release.modules.map(({ name, source }) => ({ name, source })),
  {
    name: wrapperName,
    source: `
import { WorkerEntrypoint } from "cloudflare:workers";
export * from ${JSON.stringify(`./${release.main}`)};
export { default as WIDEFLEET_CONNECTOR } from ${JSON.stringify(`./${release.main}`)};
// Public HTTP traffic never reaches connector code, including during first deployment.
export default { fetch() { return new Response("Not found", { status: 404 }); } };
export class WIDEFLEET_SECRET_READER extends WorkerEntrypoint {
  get(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || name.startsWith("WIDEFLEET_") || name === "__proto__")
      throw new Error("Invalid connector secret name");
    const binding = "WIDEFLEET_SECRET_" + name;
    if (!Object.hasOwn(this.env, binding)) throw new Error("Connector secret is not configured");
    return this.env[binding];
  }
}
`,
  },
];

export const connectorMigrations = (
  release: z.infer<typeof contract.connectorPackage>,
  current: string | null,
) => {
  const migrations = release.configuration.migrations;

  const index =
    current === null ? -1 : migrations.findIndex((migration) => migration.tag === current);

  if (current !== null && index < 0)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "Retain the deployed connector migration history before adding new migrations",
    });
  const pending = migrations.slice(index + 1);
  const last = pending.at(-1);

  return last
    ? {
        old_tag: current ?? undefined,
        new_tag: last.tag,
        steps: pending.map(({ new_sqlite_classes }) => ({ new_sqlite_classes })),
      }
    : undefined;
};

export const provisionConnectorResources = async (
  provisioner: ReturnType<typeof createCloudflareProvisioner>,
  fleetId: string,
  release: z.infer<typeof contract.connectorPackage>,
) => {
  const scope = `${fleetId}/connector/${release.name}`;
  const resources = [];

  for (const binding of release.configuration.d1_databases)
    resources.push({
      type: "d1" as const,
      name: binding.binding,
      id: await provisioner.ensureDatabase(
        cloudflareResourceName(scope, "d1", binding.database_id ?? binding.database_name),
      ),
    });

  for (const binding of release.configuration.r2_buckets) {
    const name = cloudflareResourceName(scope, "r2", binding.bucket_name);
    await provisioner.ensureBucket(name);
    resources.push({ type: "r2_bucket" as const, name: binding.binding, bucket_name: name });
  }

  for (const binding of release.configuration.kv_namespaces)
    resources.push({
      type: "kv_namespace" as const,
      name: binding.binding,
      namespace_id: await provisioner.ensureNamespace(
        cloudflareResourceName(scope, "kv", binding.id),
      ),
    });

  return resources;
};

export const connectorUpload = (
  id: string,
  workerName: string,
  release: z.infer<typeof contract.connectorPackage>,
  resources: Awaited<ReturnType<typeof provisionConnectorResources>>,
  secrets: Record<string, string>,
  migrationTag: string | null,
) => {
  validateHostedConnector(release, Object.keys(secrets));

  for (const secret of Object.values(secrets)) validateHostedSecret(secret);
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: wrapperName,
      compatibility_date: release.configuration.compatibility_date,
      compatibility_flags: release.configuration.compatibility_flags,
      annotations: { "workers/tag": id },
      observability: { enabled: true },
      migrations: connectorMigrations(release, migrationTag),
      bindings: [
        ...resources,
        ...Object.entries(release.configuration.vars).map(([name, text]) => ({
          type: "plain_text",
          name,
          text,
        })),
        ...Object.entries(secrets).map(([name, text]) => ({
          type: "secret_text",
          name: `WIDEFLEET_SECRET_${name}`,
          text,
        })),
        ...release.configuration.durable_objects.bindings.map(({ name, class_name }) => ({
          type: "durable_object_namespace",
          name,
          class_name,
        })),
        {
          type: "service",
          name: "WIDEFLEET_SECRETS",
          service: workerName,
          entrypoint: "WIDEFLEET_SECRET_READER",
        },
      ],
    }),
  );

  for (const module of connectorWorkerModules(release))
    form.set(
      module.name,
      new Blob([module.source], { type: "application/javascript+module" }),
      module.name,
    );

  return form;
};
