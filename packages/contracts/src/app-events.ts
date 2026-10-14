import { z } from "zod";

export const appEventConfiguration = z.object({
  crons: z.record(z.string(), z.array(z.string())),
  queues: z.record(z.string(), z.object({ hostname: z.string(), queue: z.string() })),
});
