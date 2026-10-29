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
    organizationId: app.organizationId,
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
    "WIDEFLEET_SECRETS",
    context.exports.AppSecrets({ props: { appId: app.appId, revision: app.secretRevision ?? 0 } }),
  );
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
    bindings.set(`WIDEFLEET_SERVICE_${name}`, context.exports.AppService({ props: grant }));

  const modules = new Map(Object.entries(worker.modules));

  // celld 0.6.2 registers the first builtin import surface it encounters.
  // Import the full namespace before linking app and platform sibling modules.
  modules.set(
    "__widefleet_bootstrap.js",
    `import * as workers from 'cloudflare:workers'; import './__widefleet_bindings.js'; export {default} from './__widefleet_app.js'; export {Events} from './__widefleet_events.js';
${(app.metadata.entrypoints ?? [])
  .filter((name) => name !== "default")
  .map((name) => `export {${name}} from ${JSON.stringify(`./${app.metadata.main_module}`)};`)
  .join("\n")}`,
  );
  modules.set(
    "__widefleet_app.js",
    app.metadata.web === false
      ? `import * as app from ${JSON.stringify(`./${app.metadata.main_module}`)}; export default app.default ?? {};`
      : `export {default} from ${JSON.stringify(`./${app.metadata.main_module}`)};`,
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
        : worker.compatibilityFlags,
    mainModule: "__widefleet_bootstrap.js",
    modules: Object.fromEntries(modules),
    env: Object.fromEntries(bindings),
    globalOutbound: context.exports.Gateway({ props: { origins: app.network.policy.backend } }),
    tails: workerTails(
      environment,
      context,
      {
        organizationId: app.organizationId,
        appId: app.appId,
        deploymentId: app.deploymentId,
        buildId: app.metadata.debug?.build_id ?? null,
      },
      app.telemetry,
    ),
  };
};
