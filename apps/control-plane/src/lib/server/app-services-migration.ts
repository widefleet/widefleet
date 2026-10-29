import type { R2Bucket, R2ListOptions, R2PutOptions } from "@cloudflare/workers-types";
import { z } from "zod";

// SQL cannot update published snapshots. Remove the retired grants before the
// first operation reads those snapshots with the app-only publication schema.
export const migrateAppServices = async (bucket: R2Bucket) => {
  const marker = "migrations/app-services-v3.json";

  if (await bucket.head(marker)) return;

  for (const prefix of ["hosts/", "versions/"]) {
    let cursor: string | undefined;

    do {
      const options: R2ListOptions = { prefix };

      if (cursor) options.cursor = cursor;
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

      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  await bucket.put(marker, "{}");
};
