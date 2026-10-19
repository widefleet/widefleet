import { publishedHost } from "@platform/contracts";
import type { ParentEnvironment, PublishedApp } from "./types.ts";

export const readApp = async (environment: ParentEnvironment, key: string) => {
  const object = await environment.WIDEFLEET_PACKAGES.get(key);

  if (!object) return null;
  const entry = publishedHost.parse(await object.json());

  return "deleted" in entry ? null : entry;
};

export const appKey = (app: PublishedApp) => app.version;
