import type { AnalyticsConfiguration } from "#lib/analytics-config";
import type { ClientContext } from "#lib/analytics-client";
import type { Runtime } from "#server/runtime-services";
import type { Authentication } from "#server/auth";
import type { HTMLAttributes } from "svelte/elements";

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

// The browser renders <install> as its own install button for another site's web app.
declare module "svelte/elements" {
  export interface SvelteHTMLElements {
    install: HTMLAttributes<HTMLElement> & {
      manifest?: string;
      manifestid?: string;
      oninstallresult?: (event: Event) => void;
    };
  }
}

export {};
