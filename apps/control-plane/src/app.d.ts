import type { AnalyticsConfiguration } from "#lib/analytics-config";
import type { Runtime } from "#server/runtime-services";
import type { Authentication } from "#server/auth";

declare global {
  namespace App {
    interface PageData {
      analytics?: AnalyticsConfiguration | null;
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
