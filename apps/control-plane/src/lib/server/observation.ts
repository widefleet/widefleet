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
  exception?: (error: Error) => void | Promise<void>;
  close: () => Promise<void>;
}

export const observe = (observer: Observation | undefined, event: ObservationEvent) => {
  runExtensionEffect(() => observer?.capture(event));
};
