import { publishedHost, serviceDocumentation } from "@platform/contracts";
import type { ParentEnvironment, PublishedApp } from "./types.ts";
import { reportRuntimeException } from "./runtime-errors.ts";

export const readApp = async (environment: ParentEnvironment, key: string) => {
  try {
    const object = await environment.WIDEFLEET_PACKAGES.get(key);

    if (!object) return null;
    const entry = publishedHost.parse(await object.json());

    return "deleted" in entry ? null : entry;
  } catch (cause) {
    reportRuntimeException(cause, environment, { operation: "read_app" });
    throw cause;
  }
};

export const appKey = (app: PublishedApp) => app.version;

// Select documentation by the serving artifact, so failed deployments and rollbacks
// cannot expose another version's signatures.
export const readServiceDocumentation = async (
  environment: ParentEnvironment,
  app: PublishedApp,
) => {
  const object = await environment.WIDEFLEET_PACKAGES.get(
    `apps/${app.appId}/service-documentation/${app.id}.json`,
  );

  return object ? serviceDocumentation.parse(await object.json()) : null;
};
