import { browser, dev, version } from "$app/env";
import { describeError } from "./errors.ts";

const recent = new Map<string, number>();

let windowStart = 0;

let sent = 0;

/** Report a handled browser failure. Automatic hooks use this same bounded transport. */
export const captureError = (cause: unknown) => {
  if (!browser || dev) return;

  try {
    const now = Date.now();

    if (now - windowStart >= 60_000) {
      recent.clear();
      windowStart = now;
      sent = 0;
    }

    if (sent >= 20) return;
    const details = describeError(cause);
    const key = `${details.message}\n${details.stack}`;

    if (recent.has(key)) return;
    recent.set(key, now);
    sent += 1;

    void fetch("/_widefleet/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        buildId: version,
        route: location.pathname.slice(0, 1024),
        ...details,
      }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {
      // Reporting is best-effort and must never create another unhandled rejection.
    });
  } catch {
    // Error handling must not affect application behavior, including during page teardown.
  }
};
