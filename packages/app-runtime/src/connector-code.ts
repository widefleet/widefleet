import { WorkerEntrypoint } from "cloudflare:workers";
import { connectorSecretName } from "@platform/contracts";
import { z } from "zod";
import {
  connectorSnapshot,
  connectorScope,
  decryptConnectorSecrets,
  readConnector,
} from "./connector-publication.ts";
import type { ParentEnvironment } from "./types.ts";
import { workerDefinition, workerTails } from "./worker-definition.ts";

export const connectorCode = async (
  snapshot: z.infer<typeof connectorSnapshot>,
  environment: ParentEnvironment,
  context: Pick<ExecutionContext, "exports">,
) => {
  const { release, organizationId, version } = snapshot;
  const identity = { organizationId, name: release.name, version };
  const configuration = release.metadata;

  const worker = await workerDefinition(
    {
      scope: connectorScope(identity),
      identity: { organizationId, connector: release.name, connectorVersion: version },
      metadata: configuration,
      modules: release.modules,
      nativeBindings: snapshot.nativeBindings,
      objects: configuration.durable_objects.map((binding) => ({
        ...binding,
        scope: JSON.stringify([organizationId, release.name, binding.class_name]),
      })),
    },
    environment,
    context,
  );

  const bindings = new Map(Object.entries(worker.env));

  bindings.set("WIDEFLEET_SECRETS", context.exports.ConnectorSecrets({ props: identity }));

  if (snapshot.browserOrigin) bindings.set("WIDEFLEET_ORIGIN", snapshot.browserOrigin);

  for (const binding of configuration.durable_objects)
    bindings.set(
      `WIDEFLEET_STATE_${binding.name}`,
      context.exports.ConnectorState({ props: { ...identity, className: binding.class_name } }),
    );

  const modules = new Map(Object.entries(worker.modules));

  const classes = [...new Set(configuration.durable_objects.map((binding) => binding.class_name))];

  modules.set(
    "__widefleet_connector.js",
    `
import * as workers from 'cloudflare:workers';
import { connectorResponse } from './__widefleet_bindings.js';
import * as connector from ${JSON.stringify(`./${configuration.main_module}`)};
export * from ${JSON.stringify(`./${configuration.main_module}`)};
export { default } from ${JSON.stringify(`./${configuration.main_module}`)};
${classes
  .map(
    (name, index) => `
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
    super(ctx, env);
    this.#pending = pending;
  }
  async fetch(request) {
    return connectorResponse(await super.fetch(request), request.signal, this.ctx);
  }
  async WIDEFLEET_DRAIN() { while (this.#pending.size) await Promise.allSettled([...this.#pending]); }
};
export { Facet${index} as ${name} };
`,
  )
  .join("\n")}
export class WIDEFLEET_READY extends workers.WorkerEntrypoint {
  ready() {
    for (const name of ${JSON.stringify([...configuration.entrypoints, ...classes])})
      if (!(name in connector)) throw new Error('Connector export is missing: ' + name);
    return true;
  }
}
`,
  );

  return {
    ...worker,
    // Facet response readers must observe disconnects even while a read is pending.
    compatibilityFlags: [...worker.compatibilityFlags, "enable_request_signal"],
    mainModule: "__widefleet_connector.js",
    modules: Object.fromEntries(modules),
    env: Object.fromEntries(bindings),
    tails: workerTails(
      environment,
      context,
      { organizationId, connector: release.name, connectorVersion: version },
      snapshot.telemetry,
    ),
  };
};

export const loadConnectorWorker = (
  snapshot: z.infer<typeof connectorSnapshot>,
  environment: ParentEnvironment,
  context: Pick<ExecutionContext, "exports">,
) =>
  environment.WIDEFLEET_LOADER.get(
    `connector:${snapshot.organizationId}:${snapshot.release.name}:${snapshot.version}`,
    () => connectorCode(snapshot, environment, context),
  );

export class ConnectorSecrets extends WorkerEntrypoint<
  ParentEnvironment,
  { organizationId: string; name: string; version: string }
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
