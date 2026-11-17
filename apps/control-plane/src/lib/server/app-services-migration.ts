import type {
  CloudflareWorkersModule,
  R2Bucket,
  R2ListOptions,
  R2PutOptions,
} from "@cloudflare/workers-types";
import { z } from "zod";

// SQL cannot update published snapshots. Remove the retired grants before the
// first operation reads those snapshots with the app-only publication schema.
export const migrateAppServices = async (
  bucket: R2Bucket,
  step: Pick<CloudflareWorkersModule.WorkflowStep, "do">,
) => {
  const marker = "migrations/app-services-v3.json";

  const options = {
    retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
    timeout: "2 minutes",
  } as const;

  if (
    await step.do("app-services-cutover-status", options, async () =>
      Boolean(await bucket.head(marker)),
    )
  )
    return;

  for (const prefix of ["hosts/", "versions/"]) {
    let cursor: string | null = null;
    let pageNumber = 0;

    do {
      const previous = cursor;
      cursor = await step.do(`app-services-cutover-${prefix}${pageNumber++}`, options, async () => {
        // Bound every checkpoint independently of the retained deployment history.
        const options: R2ListOptions = { prefix, limit: 32 };

        if (previous) options.cursor = previous;
        const page = await bucket.list(options);

        for (const entry of page.objects) {
          const object = await bucket.get(entry.key);

          if (!object) continue;
          const snapshot = z.record(z.string(), z.json()).parse(await object.json());
          const capabilities = z.record(z.string(), z.json()).safeParse(snapshot["capabilities"]);

          if (
            !capabilities.success ||
            !Object.values(capabilities.data).some(
              (value) => z.object({ connector: z.string() }).safeParse(value).success,
            )
          )
            continue;

          const options: R2PutOptions = { onlyIf: { etagMatches: object.etag } };

          if (object.httpMetadata) options.httpMetadata = object.httpMetadata;

          if (object.customMetadata) options.customMetadata = object.customMetadata;

          const updated = await bucket.put(
            entry.key,
            JSON.stringify({ ...snapshot, capabilities: {} }),
            options,
          );

          if (!updated)
            throw new Error(
              "Publication changed during the app services migration; retry the operation",
            );
        }

        return page.truncated ? page.cursor : null;
      });
    } while (cursor);
  }

  await step.do("app-services-cutover-complete", options, async () => {
    await bucket.put(marker, "{}");
  });
};
