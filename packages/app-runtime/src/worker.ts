import { bytes } from "./catalog.ts";
import type { ParentEnvironment, PublishedApp } from "./types.ts";

export const workerCode = async (
  app: PublishedApp,
  environment: ParentEnvironment,
  context: ExecutionContext,
  workflow?: string,
) => {
  const bindings = new Map<string, string | Fetcher>([
    ["WIDEFLEET_DEPLOYMENT_ID", app.deploymentId],
    [
      app.metadata.assets.binding,
      context.exports.Assets({ props: { version: `versions/${app.appId}/${app.version}.json` } }),
    ],
  ]);

  for (const binding of app.metadata.bindings) {
    if (binding.type === "plain_text") {
      bindings.set(binding.name, binding.text);
      continue;
    }

    if (binding.type === "workflow") {
      bindings.set(
        `WIDEFLEET_WORKFLOW_${binding.name}`,
        context.exports.WorkflowBinding({
          props: { appId: app.appId, hostname: app.hostname, workflow: binding.workflow_name },
        }),
      );
      continue;
    }

    const name = app.nativeBindings[binding.name];

    if (!name) throw new Error("App resource has no native binding");
    const options = { props: { name } };

    switch (binding.type) {
      case "d1":
        bindings.set(`WIDEFLEET_D1_${binding.name}`, context.exports.Database(options));
        break;
      case "r2_bucket":
        bindings.set(`WIDEFLEET_R2_${binding.name}`, context.exports.Objects(options));
        break;
      case "kv_namespace":
        bindings.set(`WIDEFLEET_KV_${binding.name}`, context.exports.KeyValue(options));
        break;
      case "queue":
        bindings.set(`WIDEFLEET_QUEUE_${binding.name}`, context.exports.Producer(options));
        break;
    }
  }

  for (const [name, nativeName] of Object.entries(app.capabilities)) {
    const capability = environment[nativeName];

    if (!capability) throw new Error("Granted connector is not installed");
    // SAFETY: Capability names refer exclusively to native service bindings
    // selected by administrators. celld preserves their native RPC surface.
    bindings.set(name, capability as Fetcher);
  }

  const modules = new Map<string, string | WorkerLoaderModule>();

  for (const module of app.modules) {
    if (module.type === "sourcemap") continue;
    const data = await bytes(environment, app, module.sha256);

    switch (module.type) {
      case "esm":
        modules.set(
          module.name,
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data),
        );
        break;
      case "text":
        modules.set(module.name, {
          text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data),
        });
        break;
      case "wasm":
        modules.set(module.name, { wasm: data });
        break;
      case "data":
        modules.set(module.name, { data });
        break;
    }
  }

  // celld 0.6.2 registers the first builtin import surface it encounters.
  // Import the full namespace before linking app and platform sibling modules.
  modules.set(
    "__widefleet_bootstrap.js",
    "import * as workers from 'cloudflare:workers'; import './__widefleet_bindings.js'; export {default} from './__widefleet_app.js'; export {Events} from './__widefleet_events.js';",
  );
  modules.set(
    "__widefleet_app.js",
    `export {default} from ${JSON.stringify(`./${app.metadata.main_module}`)};`,
  );
  modules.set(
    "__widefleet_bindings.js",
    `const WIDEFLEET_CONFIGURATION = ${JSON.stringify({ metadata: app.metadata })};\n${WIDEFLEET_BINDINGS_SOURCE}`,
  );
  modules.set("__widefleet_events.js", WIDEFLEET_EVENTS_SOURCE);

  if (workflow) {
    const declaration = app.metadata.bindings.find(
      (binding) => binding.type === "workflow" && binding.workflow_name === workflow,
    );

    if (declaration?.type !== "workflow")
      throw new Error("Workflow is not declared in the pinned app version");
    modules.set(
      "__widefleet_workflow.js",
      `export {${declaration.class_name} as default} from ${JSON.stringify(`./${app.metadata.main_module}`)};`,
    );
    modules.set("__widefleet_workflow_runner.js", WIDEFLEET_WORKFLOW_SOURCE);
    modules.set(
      "__widefleet_bootstrap.js",
      "import * as workers from 'cloudflare:workers'; import './__widefleet_bindings.js'; export {WorkflowRunner} from './__widefleet_workflow_runner.js';",
    );
  }

  return {
    compatibilityDate: app.metadata.compatibility_date,
    compatibilityFlags:
      workflow && !app.metadata.compatibility_flags.includes("nodejs_compat")
        ? [...new Set([...app.metadata.compatibility_flags, "nodejs_als"])]
        : app.metadata.compatibility_flags,
    mainModule: "__widefleet_bootstrap.js",
    modules: Object.fromEntries(modules),
    env: Object.fromEntries(bindings),
    globalOutbound: context.exports.Gateway({ props: { origins: app.network.policy.backend } }),
    tails: app.telemetry
      ? [
          context.exports.Telemetry({
            props: {
              ...app.telemetry,
              deploymentId: app.deploymentId,
              buildId: app.metadata.debug?.build_id ?? null,
            },
          }),
        ]
      : [],
  };
};
