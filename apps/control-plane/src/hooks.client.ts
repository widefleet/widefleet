import type { HandleClientError } from "@sveltejs/kit/hooks";
import { captureBrowserException } from "#lib/analytics-client";
import { reportBrowserError } from "#lib/reporting-client";

export const handleError: HandleClientError = ({ error, kind }) => {
  if (kind === "unknown" && error instanceof Error) {
    console.error(error);
    reportBrowserError(error);
    captureBrowserException(error);
  }
};
