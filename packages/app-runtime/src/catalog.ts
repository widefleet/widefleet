import { publishedApp } from "@platform/contracts";
import type { ParentEnvironment, PublishedApp } from "./types.ts";

export const readApp = async (environment: ParentEnvironment, key: string) => {
  const object = await environment.WIDEFLEET_PACKAGES.get(key);

  return object ? publishedApp.parse(await object.json()) : null;
};

export const appKey = (app: PublishedApp) => app.version;

export const bytes = async (environment: ParentEnvironment, app: PublishedApp, hash: string) => {
  const object = await environment.WIDEFLEET_PACKAGES.get(`apps/${app.appId}/modules/${hash}`);

  if (!object) throw new Error("Published module is missing");
  const data = await object.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));

  if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== hash)
    throw new Error("Published module checksum mismatch");

  return data;
};
