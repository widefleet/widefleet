import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { authControlPath } from "@platform/auth-proxy/publication";
import { createInstalledAppSignIn } from "./app-sign-in-installed.ts";
import type { Configuration } from "./config.ts";

export const createAppSignIn = (configuration: Configuration, cookieSecret: string) =>
  createInstalledAppSignIn(
    configuration,
    cookieSecret,
    async (method, body) => {
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
        signal: AbortSignal.timeout(15_000),
      };

      if (method === "PUT") options.body = body ?? null;

      const response = await fetch(
        new URL(`${authControlPath}/configuration`, configuration.PLATFORM_APP_RUNTIME_URL),
        options,
      );

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `The auth proxy could not apply its configuration (HTTP ${response.status})`,
        );
      }

      return response;
    },
    "immediate",
  );
