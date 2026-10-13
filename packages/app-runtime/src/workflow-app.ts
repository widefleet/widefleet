import { readApp } from "./catalog.ts";
import type { ParentEnvironment } from "./types.ts";
import type { Start } from "./workflow-protocol.ts";

export const workflowApp = async (start: Start, environment: ParentEnvironment) => {
  const current = await readApp(environment, `hosts/${start.hostname}.json`);
  const pinned = await readApp(environment, `versions/${start.appId}/${start.version}.json`);

  if (!current || current.appId !== start.appId || !pinned || pinned.appId !== start.appId)
    throw new Error("Workflow app is no longer published");

  return {
    ...pinned,
    network: current.network,
    telemetry: current.telemetry,
    capabilities: Object.fromEntries(
      Object.entries(pinned.capabilities).filter(
        ([name, native]) => current.capabilities[name] === native,
      ),
    ),
  };
};
