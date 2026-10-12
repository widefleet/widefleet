import { createIsomorphicFn } from "@tanstack/react-start";
import { captureError as captureBrowserError } from "./capture-error.ts";
import { captureError as captureServerError } from "./server/capture-error.ts";

export const reportError = createIsomorphicFn()
  .client(captureBrowserError)
  .server(captureServerError);
