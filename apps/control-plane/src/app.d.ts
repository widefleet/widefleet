import type { Principal } from "#server/identity";
import type { z } from "zod";
import type { organizationChoice } from "@platform/contracts";
import type { Runtime } from "#server/runtime-services";

declare global {
  namespace App {
    interface PageData {
      principal?: Principal;
      organizations?: z.infer<typeof organizationChoice>[];
    }

    interface Locals {
      runtime: () => Promise<Runtime>;
    }
  }
}

export {};
