import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { createHash } from "node:crypto";
import { z } from "zod";
import { InvalidOperation } from "./errors.ts";
import type { ArtifactStorage } from "./storage.ts";

const sourceMapFile = z.object({
  version: z.literal(3),
  sources: z.array(z.string()).max(100_000),
  names: z.array(z.string()),
  mappings: z.string(),
});

export type WorkerModule = {
  name: string;
  type: z.infer<typeof contract.storedModule>["type"];
  bytes: Uint8Array;
};

export const storeModules = (storage: ArtifactStorage, scope: string, modules: WorkerModule[]) =>
  Result.gen(async function* () {
    for (const module of modules) {
      const sha256 = createHash("sha256").update(module.bytes).digest("hex");
      yield* Result.await(
        storage.put(`${scope}/modules/${sha256}`, module.bytes, "application/octet-stream"),
      );
    }

    return Result.ok(undefined);
  });

export const prepareModules = (
  main: string,
  modules: WorkerModule[],
  debug: z.infer<typeof contract.debugMetadata> | undefined,
) =>
  Result.gen(function* () {
    if (!modules.some((module) => module.name === main && module.type === "esm"))
      return yield* new InvalidOperation({
        code: "BAD_REQUEST",
        message: "The main ES module is missing",
      });

    if (new Set(modules.map((module) => module.name)).size !== modules.length)
      return yield* new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Duplicate worker module names",
      });

    if (
      modules.filter((module) => module.type !== "sourcemap").length > 32 ||
      modules.filter((module) => module.type === "sourcemap").length > 500 ||
      modules.reduce((size, module) => size + module.bytes.byteLength, 0) > 100 * 1024 * 1024
    )
      return yield* new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Worker module limit exceeded",
      });

    const sourceMaps = new Set(Object.values(debug?.source_maps ?? {}));

    if (
      sourceMaps.size !== modules.filter((module) => module.type === "sourcemap").length ||
      [...sourceMaps].some(
        (name) => !modules.some((module) => module.name === name && module.type === "sourcemap"),
      )
    )
      return yield* new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Source-map metadata does not match the uploaded maps",
      });

    for (const module of modules) {
      if (module.type !== "sourcemap") continue;

      const parsed = Result.try(() =>
        sourceMapFile.parse(JSON.parse(new TextDecoder().decode(module.bytes))),
      );

      if (parsed.isErr())
        return yield* new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Invalid source-map JSON",
        });
    }

    const stored = contract.artifact.shape.modules.safeParse(
      modules.map((module) => ({
        name: module.name,
        type: module.type,
        size: module.bytes.byteLength,
        sha256: createHash("sha256").update(module.bytes).digest("hex"),
      })),
    );

    if (!stored.success)
      return yield* new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Invalid worker module name or size",
      });

    return Result.ok(stored.data.sort((left, right) => left.name.localeCompare(right.name)));
  });
