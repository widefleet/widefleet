import { runExtensionEffect } from "../extension-effects.ts";
import type { PostHog } from "posthog-node";

export interface ObservationEvent {
  event:
    | "user_created"
    | "user_signed_in"
    | "organization_created"
    | "app_created"
    | "deployment_completed"
    | "authentication_decision";
  id: string;
  userId?: string;
  anonymousId?: string;
  organizationId?: string;
  properties?: Record<string, string | number | boolean>;
}

export interface Observation {
  // Capture is nonblocking; implementations drain their pending delivery in close.
  capture: (event: ObservationEvent) => void | Promise<void>;
  exception?: (
    error: Error,
    distinctId?: string,
    properties?: Parameters<PostHog["captureException"]>[2],
  ) => void | Promise<void>;
  // Links another distinct ID, such as an app identity, to the user's person.
  alias?: (userId: string, alias: string) => void | Promise<void>;
  close: () => Promise<void>;
}

export const observe = (observer: Observation | undefined, event: ObservationEvent) => {
  runExtensionEffect(() => observer?.capture(event));
};
