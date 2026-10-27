import type * as contract from "@platform/contracts";
import type { z } from "zod";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { InvalidOperation } from "./errors.ts";

export const validateAppQueues = (
  bindings: Pick<CloudflareBindings, "WIDEFLEET_QUEUES">,
  metadata: z.infer<typeof contract.workerMetadata>,
) => {
  if (
    bindings.WIDEFLEET_QUEUES === "false" &&
    (metadata.queue_consumers.length ||
      metadata.bindings.some((binding) => binding.type === "queue"))
  )
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Queues are disabled for this installation",
    });
};
