import { building } from "$app/env";
import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { createRequestRuntime } from "#server/runtime-services";
import { getRuntime } from "#server/runtime-node";

export const init: ServerInit = async () => {
  if (!building) await getRuntime();
};

import { handleExtensionRequest } from "#request-extension";

export const handle: Handle = async ({ event, resolve }) => {
  const extensionResponse = await handleExtensionRequest(event.request);

  if (extensionResponse) return extensionResponse;
  event.locals.runtime = createRequestRuntime(getRuntime);

  return resolve(event);
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
