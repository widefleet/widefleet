import type { ClientInit, HandleClientError } from "@sveltejs/kit/hooks";
import { captureError } from "./lib/capture-error.ts";

export const init: ClientInit = () => {
  window.addEventListener("error", (event) => captureError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => captureError(event.reason));
};

export const handleError: HandleClientError = ({ kind, error }) => {
  if (kind === "unknown" || error.status >= 500) captureError(error);
};
