import { WorkerEntrypoint } from "cloudflare:workers";
import { connectorSecretName } from "@platform/contracts";
import { z } from "zod";
import {
  connectorSnapshot,
  decryptConnectorSecrets,
  digest,
  readConnector,
} from "./connector-publication.ts";
import type { ParentEnvironment } from "./types.ts";

export const connectorCode = async (
  snapshot: z.infer<typeof connectorSnapshot>,
  environment: ParentEnvironment,
  context: Pick<ExecutionContext, "exports">,
) => {
  const { release, fleetId, version } = snapshot;
  const identity = { fleetId, name: release.name, version };
  const configuration = release.configuration;
  const bindings = new Map<string, string | Fetcher>(Object.entries(configuration.vars));

  const resources = [
    ...configuration.d1_databases.map((item) => ({
      type: "d1" as const,
      name: item.binding,
      database_name: item.database_name,
    })),
    ...configuration.r2_buckets.map((item) => ({
      type: "r2_bucket" as const,
      name: item.binding,
      bucket_name: item.bucket_name,
    })),
    ...configuration.kv_namespaces.map((item) => ({
      type: "kv_namespace" as const,
      name: item.binding,
      id: item.id,
    })),
  ];

  for (const resource of resources) {
    const name = snapshot.nativeBindings[resource.name];

    if (!name || !environment[name]) throw new Error("Connector resource is not installed");
    const options = { props: { name } };

    switch (resource.type) {
      case "d1":
        bindings.set(`WIDEFLEET_D1_${resource.name}`, context.exports.Database(options));
        break;
      case "r2_bucket":
        bindings.set(`WIDEFLEET_R2_${resource.name}`, context.exports.Objects(options));
        break;
      case "kv_namespace":
        bindings.set(`WIDEFLEET_KV_${resource.name}`, context.exports.KeyValue(options));
        break;
    }
  }

  bindings.set("WIDEFLEET_SECRETS", context.exports.ConnectorSecrets({ props: identity }));

  for (const binding of configuration.durable_objects.bindings)
    bindings.set(
      `WIDEFLEET_STATE_${binding.name}`,
      context.exports.ConnectorState({ props: { ...identity, className: binding.class_name } }),
    );

  const modules = new Map<string, string>();

  for (const module of release.modules) {
    if (module.name.startsWith("__widefleet_") || (await digest(module.source)) !== module.sha256)
      throw new Error("Connector module name or checksum is invalid");
    modules.set(module.name, module.source);
  }

  modules.set(
    "__widefleet_bindings.js",
    `const WIDEFLEET_CONFIGURATION = ${JSON.stringify({ metadata: { bindings: resources }, objects: configuration.durable_objects.bindings.map((binding) => ({ ...binding, scope: JSON.stringify([fleetId, release.name, binding.class_name]) })) })};\n${WIDEFLEET_BINDINGS_SOURCE}`,
  );

  const classes = [
    ...new Set(configuration.durable_objects.bindings.map((binding) => binding.class_name)),
  ];

  modules.set(
    "__widefleet_connector.js",
    `
import * as workers from 'cloudflare:workers';
import { connectorResponse } from './__widefleet_bindings.js';
import * as connector from ${JSON.stringify(`./${release.main}`)};
export * from ${JSON.stringify(`./${release.main}`)};
export { default } from ${JSON.stringify(`./${release.main}`)};
${classes
  .map((name, index) => {
    const binding = configuration.durable_objects.bindings.find((item) => item.class_name === name);

    if (!binding) throw new Error("Connector Durable Object binding is missing");

    return `
const Facet${index} = class extends connector[${JSON.stringify(name)}] {
  #pending;
  constructor(ctx, env) {
    const pending = new Set();
    const waitUntil = ctx.waitUntil.bind(ctx);
    Object.defineProperty(ctx, 'waitUntil', { configurable: true, value(promise) {
      const task = Promise.resolve(promise);
      pending.add(task);
      task.then(() => pending.delete(task), () => pending.delete(task));
      waitUntil(task);
    }});
    const gateway = env[${JSON.stringify(`WIDEFLEET_STATE_${binding.name}`)}];
    Object.defineProperties(ctx.storage, {
      getAlarm: { configurable: true, value: () => gateway.scheduleAlarm(ctx.props.objectId, 'get') },
      setAlarm: { configurable: true, value: async (time) => { await gateway.scheduleAlarm(ctx.props.objectId, 'set', Number(time)); } },
      deleteAlarm: { configurable: true, value: async () => { await gateway.scheduleAlarm(ctx.props.objectId, 'delete'); } },
    });
    super(ctx, env);
    this.#pending = pending;
  }
  async fetch(request) {
    return connectorResponse(await super.fetch(request), request.signal, this.ctx);
  }
  async WIDEFLEET_DRAIN() { while (this.#pending.size) await Promise.allSettled([...this.#pending]); }
  WIDEFLEET_ALARM(info) { return super.alarm(info); }
};
export { Facet${index} as ${name} };
`;
  })
  .join("\n")}
export class WIDEFLEET_READY extends workers.WorkerEntrypoint {
  ready() {
    for (const name of ${JSON.stringify([...release.entrypoints, ...classes])})
      if (!(name in connector)) throw new Error('Connector export is missing: ' + name);
    return true;
  }
}
`,
  );

  return {
    compatibilityDate: configuration.compatibility_date,
    // Facet response readers must observe disconnects even while a read is pending.
    compatibilityFlags: [...configuration.compatibility_flags, "enable_request_signal"],
    mainModule: "__widefleet_connector.js",
    modules: Object.fromEntries(modules),
    env: Object.fromEntries(bindings),
  };
};

export const loadConnectorWorker = (
  snapshot: z.infer<typeof connectorSnapshot>,
  environment: ParentEnvironment,
  context: Pick<ExecutionContext, "exports">,
) =>
  environment.WIDEFLEET_LOADER.get(
    `connector:${snapshot.fleetId}:${snapshot.release.name}:${snapshot.version}`,
    () => connectorCode(snapshot, environment, context),
  );

export class ConnectorSecrets extends WorkerEntrypoint<
  ParentEnvironment,
  { fleetId: string; name: string; version: string }
> {
  async get(name: string) {
    connectorSecretName.parse(name);
    const snapshot = await readConnector(this.env, this.ctx.props);
    const secrets = await decryptConnectorSecrets(this.env, this.ctx.props, snapshot.ciphertext);

    if (!Object.hasOwn(secrets, name))
      throw new Error(`Connector secret ${name} is not configured`);

    return secrets[name];
  }
}
