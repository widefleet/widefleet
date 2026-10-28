import type { AnalyticsConfiguration } from "#lib/analytics-config";
import type { Principal } from "#server/identity";
import type { z } from "zod";
import type { organizationChoice } from "@platform/contracts";
import type { Runtime } from "#server/runtime-services";

declare global {
  namespace App {
    interface PageData {
      analytics?: AnalyticsConfiguration | null;
      principal?: Principal;
      organizations?: z.infer<typeof organizationChoice>[];
    }

    interface Locals {
      analytics: AnalyticsConfiguration | null;
      runtime: () => Promise<Runtime>;
    }
  }
}

export {};
