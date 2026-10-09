import { reportingPreferences, sanitizeReportingError } from "@platform/contracts";

let enabled = false;

let sent = 0;

let since = Date.now();

export const reportBrowserError = (error: Error) => {
  if (!enabled) return;

  if (Date.now() - since >= 60_000) {
    sent = 0;
    since = Date.now();
  }

  if (sent >= 5) return;
  sent += 1;
  void fetch("/api/v1/reporting/errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: process.env["WIDEFLEET_BUILD_VERSION"] ?? "0.0.0",
      error: sanitizeReportingError(error),
    }),
    signal: AbortSignal.timeout(1500),
    keepalive: true,
  }).catch(() => {});
};

export const startBrowserReporting = () => {
  let stopped = false;

  const refresh = async () => {
    try {
      const response = await fetch("/api/v1/reporting/status", {
        signal: AbortSignal.timeout(1500),
      });

      const status = response.ok ? reportingPreferences.parse(await response.json()) : null;
      enabled = !stopped && status?.crashes === true;
    } catch {
      enabled = false;
    }
  };

  const error = (event: ErrorEvent) => {
    if (event.error instanceof Error) reportBrowserError(event.error);
  };

  const rejection = (event: PromiseRejectionEvent) => {
    if (event.reason instanceof Error) reportBrowserError(event.reason);
  };

  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  void refresh();

  const timer = setInterval(() => {
    void refresh();
  }, 60_000);

  return () => {
    stopped = true;
    enabled = false;
    clearInterval(timer);
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
  };
};
