import { workerDefinition, workerTails } from "./worker-definition.ts";
import type { ParentEnvironment, PublishedApp } from "./types.ts";

export const workerCode = async (
  app: PublishedApp,
  environment: ParentEnvironment,
  context: ExecutionContext,
  workflow?: string,
  workflowSource = WIDEFLEET_WORKFLOW_SOURCE,
) => {
  const identity = {
    appId: app.appId,
    deploymentId: app.deploymentId,
    buildId: app.metadata.debug?.build_id ?? null,
  };

  const worker = await workerDefinition(
    {
      scope: `apps/${app.appId}`,
      identity,
      metadata: app.metadata,
      modules: app.modules,
      nativeBindings: app.nativeBindings,
      capabilities: Object.keys(app.capabilities),
    },
    environment,
    context,
  );

  const bindings = new Map(Object.entries(worker.env));
  bindings.set("WIDEFLEET_DEPLOYMENT_ID", app.deploymentId);
  bindings.set(
    app.metadata.assets.binding,
    context.exports.Assets({ props: { version: `versions/${app.appId}/${app.version}.json` } }),
  );

  for (const binding of app.metadata.bindings)
    if (binding.type === "workflow")
      bindings.set(
        `WIDEFLEET_WORKFLOW_${binding.name}`,
        context.exports.WorkflowBinding({
          props: { appId: app.appId, hostname: app.hostname, workflow: binding.workflow_name },
        }),
      );

  for (const [name, grant] of Object.entries(app.capabilities))
    bindings.set(`WIDEFLEET_CONNECTOR_${name}`, context.exports.ConnectorGateway({ props: grant }));

  const modules = new Map(Object.entries(worker.modules));

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
    modules.set("__widefleet_workflow_runner.js", workflowSource);
    modules.set(
      "__widefleet_bootstrap.js",
      "import * as workers from 'cloudflare:workers'; import './__widefleet_bindings.js'; export {WorkflowRunner} from './__widefleet_workflow_runner.js';",
    );
  }

  return {
    ...worker,
    compatibilityFlags:
      workflow && !app.metadata.compatibility_flags.includes("nodejs_compat")
        ? [...new Set([...app.metadata.compatibility_flags, "nodejs_als"])]
        : app.metadata.compatibility_flags,
    mainModule: "__widefleet_bootstrap.js",
    modules: Object.fromEntries(modules),
    env: Object.fromEntries(bindings),
    globalOutbound: context.exports.Gateway({ props: { origins: app.network.policy.backend } }),
    tails: workerTails(environment, context, identity, app.telemetry),
  };
};
