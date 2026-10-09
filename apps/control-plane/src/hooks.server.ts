import { building } from "$app/env";
import type { HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { getRuntime } from "#server/runtime";

export const init: ServerInit = async () => {
  if (!building) await getRuntime();
};

export const handleError: HandleServerError = async ({ error, kind }) => {
  if (kind === "unknown" && error instanceof Error) {
    console.error(error);

    try {
      (await getRuntime()).reporting.exception(error);
    } catch {
      /* Initialization may have failed before reporting is available. */
    }
  }
};
