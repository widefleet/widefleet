import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Configuration } from "./config.ts";

export const runtimeManagementRequest = async (
  configuration: Configuration,
  path: string,
  method: string,
  body?: string,
  signal?: AbortSignal,
) => {
  const key = z
    .string()
    .min(32)
    .parse(
      (
        await readFile(join(configuration.PLATFORM_RUNTIME_DIRECTORY, "control-token"), "utf8")
      ).trim(),
    );

  const options: RequestInit = {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    redirect: "error",
    signal: signal ?? AbortSignal.timeout(15_000),
  };

  if (body !== undefined) options.body = body;

  return fetch(new URL(path, configuration.PLATFORM_APP_RUNTIME_URL), options);
};
