import type { storedModule, workerConfiguration } from "@platform/contracts";
import type { z } from "zod";
import type { ParentEnvironment } from "./types.ts";
import { loadModules } from "./worker-modules.ts";
import { runtimeExtension } from "#runtime-extension";
import type { WorkerIdentity } from "./runtime-extension.ts";

type Definition = {
  scope: string;
  identity: WorkerIdentity;
  metadata: z.infer<typeof workerConfiguration>;
  modules: z.infer<typeof storedModule>[];
  nativeBindings: Record<string, string>;
  capabilities?: string[];
  objects?: { name: string; class_name: string; scope: string }[];
};

export const workerDefinition = async (
  input: Definition,
  environment: ParentEnvironment,
  context: Pick<ExecutionContext, "exports">,
) => {
  const bindings = new Map<string, string | Fetcher>();

  for (const binding of input.metadata.bindings) {
    if (binding.type === "workflow") continue;

    if (binding.type === "plain_text") {
      bindings.set(binding.name, binding.text);
      continue;
    }

    const name = input.nativeBindings[binding.name];

    if (!name || !environment[name]) throw new Error("Worker resource is not installed");
    const options = { props: { name } };

    switch (binding.type) {
      case "d1":
        bindings.set(
          `WIDEFLEET_D1_${binding.name}`,
          context.exports.Database({
            props: { name, binding: binding.name, identity: input.identity },
          }),
        );
        break;
      case "r2_bucket":
        bindings.set(`WIDEFLEET_R2_${binding.name}`, context.exports.Objects(options));
        break;
      case "kv_namespace":
        bindings.set(
          `WIDEFLEET_KV_${binding.name}`,
          context.exports.KeyValue({
            props: { name, binding: binding.name, identity: input.identity },
          }),
        );
        break;
      case "queue":
        bindings.set(`WIDEFLEET_QUEUE_${binding.name}`, context.exports.Producer(options));
        break;
    }
  }

  const modules = await loadModules(environment, input.scope, input.modules);
  modules.set(
    "__widefleet_bindings.js",
    `const WIDEFLEET_CONFIGURATION = ${JSON.stringify({ metadata: input.metadata, capabilities: input.capabilities ?? [], objects: input.objects ?? [] })};\n${WIDEFLEET_BINDINGS_SOURCE}`,
  );

  return {
    compatibilityDate: input.metadata.compatibility_date,
    compatibilityFlags: input.metadata.compatibility_flags,
    modules: Object.fromEntries(modules),
    env: Object.fromEntries(bindings),
  };
};

export const workerTails = (
  environment: ParentEnvironment,
  context: Pick<ExecutionContext, "exports">,
  identity: WorkerIdentity,
  destination: { url: string; token: string } | null,
) => {
  const tails =
    environment["WIDEFLEET_LOGS"] === "cloudflare"
      ? [context.exports.CloudflareTelemetry({ props: identity })]
      : destination
        ? [context.exports.Telemetry({ props: { ...destination, ...identity } })]
        : [];

  if (runtimeExtension.tail) tails.push(context.exports.RuntimeObserver({ props: identity }));

  return tails;
};
