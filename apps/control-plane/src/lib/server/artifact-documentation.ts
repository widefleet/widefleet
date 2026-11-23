import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { createHash } from "node:crypto";
import { z } from "zod";
import { InvalidOperation } from "./errors.ts";
import type { ArtifactStorage } from "./storage.ts";

type Documentation = z.infer<typeof contract.serviceDocumentation>;

/**
 * What the database keeps about an artifact's API documentation. The document
 * itself can reach megabytes, so it lives in artifact storage and only the
 * readers that present it load it. The catalog decides from `entrypoints`
 * which entrypoints to list without reading the document.
 */
export const documentationSummary = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  entrypoints: z.array(z.strictObject({ name: z.string(), documented: z.boolean() })),
});

// The app runtime reads published documentation from this key in the same bucket.
const documentationKey = (appId: string, artifactId: string) =>
  `apps/${appId}/service-documentation/${artifactId}.json`;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

export const encodeDocumentation = (documentation: Documentation) => {
  const bytes = encoder.encode(JSON.stringify(documentation));

  return {
    bytes,
    summary: documentationSummary.parse({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      entrypoints: documentation.entrypoints.map((entry) => ({
        name: entry.name,
        documented: Boolean(
          entry.methods.length ||
          entry.summary ||
          entry.remarks ||
          entry.examples.length ||
          entry.deprecated,
        ),
      })),
    }),
  };
};

const conflict = () =>
  new InvalidOperation({
    code: "CONFLICT",
    message: "This upload session already contains different API documentation",
  });

/**
 * Stores an artifact's documentation before its row is inserted. A publish can
 * write the document and then roll back, and storage keeps the first object
 * written under a key. A retry of the same upload session is accepted only when
 * it carries the same bytes, or, without documentation, when none was written:
 * the app runtime reads this key for every published artifact.
 */
export const storeDocumentation = (
  storage: ArtifactStorage,
  appId: string,
  artifactId: string,
  encoded: ReturnType<typeof encodeDocumentation> | null,
) =>
  Result.gen(async function* () {
    const key = documentationKey(appId, artifactId);

    if (!encoded) {
      if (yield* Result.await(storage.exists(key))) return yield* conflict();

      return Result.ok(undefined);
    }

    yield* Result.await(storage.put(key, encoded.bytes, "application/json"));
    const stored = yield* Result.await(storage.get(key));

    if (createHash("sha256").update(stored).digest("hex") !== encoded.summary.sha256)
      return yield* conflict();

    return Result.ok(undefined);
  });

/** Reads the documentation of an artifact whose row records a summary. */
export const readDocumentation = (storage: ArtifactStorage, appId: string, artifactId: string) =>
  Result.gen(async function* () {
    const bytes = yield* Result.await(storage.get(documentationKey(appId, artifactId)));

    // Documentation of an earlier format counts as none until the app is deployed again.
    const documentation = contract.serviceDocumentation.safeParse(
      JSON.parse(decoder.decode(bytes)),
    );

    return Result.ok(documentation.success ? documentation.data : null);
  });
