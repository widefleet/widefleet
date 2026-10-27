import type { sanitizeReportingError } from "@platform/contracts";
import { runExtensionEffect } from "../extension-effects.ts";

export interface ObservationEvent {
  event:
    | "user_created"
    | "user_signed_in"
    | "organization_created"
    | "app_created"
    | "deployment_completed";
  id: string;
  userId?: string;
  organizationId?: string;
  properties?: Record<string, string | number | boolean>;
}

export interface Observation {
  // Capture is nonblocking; implementations drain their pending delivery in close.
  capture: (event: ObservationEvent) => void | Promise<void>;
  exception?: (error: ReturnType<typeof sanitizeReportingError>) => void | Promise<void>;
  close: () => Promise<void>;
}

export const observe = (observer: Observation | undefined, event: ObservationEvent) => {
  runExtensionEffect(() => observer?.capture(event));
};

export const closeObservation = async (observer: Observation | undefined) => {
  if (!observer) return;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<void>((resolve) => {
    deadline = setTimeout(resolve, 2000);
  });

  try {
    await Promise.race([Promise.resolve().then(() => observer.close()), expired]);
  } catch {
    // Failed delivery must not prevent database cleanup.
  } finally {
    clearTimeout(deadline);
  }
};
