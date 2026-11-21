import type { AnalyticsConfiguration } from "#lib/analytics-config";
import type { Runtime } from "#server/runtime-services";
import type { Authentication } from "#server/auth";

declare global {
  namespace App {
    interface PageData {
      analytics?: AnalyticsConfiguration | null;
    }

    interface Error {
      message: string;
      // The request hook resolves these on a full page load: company sign-in or organization choice.
      code?: "SSO_REQUIRED" | "ORGANIZATION_REQUIRED";
    }

    interface Locals {
      user: Authentication["$Infer"]["Session"]["user"] | null;
      session: Authentication["$Infer"]["Session"]["session"] | null;
      analytics: AnalyticsConfiguration | null;
      runtime: () => Promise<Runtime>;
    }
  }
}

export {};
