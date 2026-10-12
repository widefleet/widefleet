import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { captureError } from "./lib/capture-error.ts";

window.addEventListener("error", (event) => captureError(event.error ?? event.message));

window.addEventListener("unhandledrejection", (event) => captureError(event.reason));

hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
  {
    onCaughtError: captureError,
    onUncaughtError: captureError,
    onRecoverableError: captureError,
  },
);
