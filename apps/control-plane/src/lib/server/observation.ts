import type { sanitizeReportingError } from "@platform/contracts";

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
  capture: (event: ObservationEvent) => void;
  exception?: (error: ReturnType<typeof sanitizeReportingError>) => void;
  close: () => Promise<void>;
}

export const observe = (observer: Observation | undefined, event: ObservationEvent) => {
  try {
    observer?.capture(event);
  } catch {
    // Observation happens after a successful operation and cannot change its result.
  }
};
