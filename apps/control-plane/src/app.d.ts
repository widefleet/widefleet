import type { AnalyticsConfiguration } from "#lib/analytics-config";
import type { ClientContext } from "#lib/analytics-client";
import type { Runtime } from "#server/runtime-services";
import type { Authentication } from "#server/auth";

declare global {
  namespace App {
    interface PageData {
      analytics?: AnalyticsConfiguration | null;
      analyticsUser?: ClientContext["user"];
    }

    interface Locals {
      user: Authentication["$Infer"]["Session"]["user"] | null;
      session: Authentication["$Infer"]["Session"]["session"] | null;
      analytics: AnalyticsConfiguration | null;
      runtime: () => Promise<Runtime>;
      // The organization a workspace page names, once the request hook has authorized it.
      workspace: { id: string; slug: string } | null;
    }
  }
}

export {};
