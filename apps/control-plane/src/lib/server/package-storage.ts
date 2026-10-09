import type * as contract from "@platform/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";
import type { ArtifactStorage } from "./storage.ts";

const key = (checksum: string) => `packages/sha256/${checksum}.json`;

export const verifyModules = (
  release:
    | Pick<z.infer<typeof contract.runtimeRelease>, "main" | "modules">
    | Pick<z.infer<typeof contract.connectorPackage>, "main" | "modules">,
) => {
  if (
    !release.modules.some((module) => module.name === release.main) ||
    new Set(release.modules.map((module) => module.name)).size !== release.modules.length ||
    release.modules.some(
      (module) => createHash("sha256").update(module.source).digest("hex") !== module.sha256,
    )
  )
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Invalid package modules or checksums",
    });
};

export const savePackage = async (
  storage: ArtifactStorage,
  release: z.infer<typeof contract.runtimeRelease> | z.infer<typeof contract.connectorPackage>,
) => {
  verifyModules(release);
  const bytes = Buffer.from(JSON.stringify(release));
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const saved = await storage.put(key(checksum), bytes, "application/json");

  if (saved.isErr()) throw saved.error;

  return checksum;
};

export const loadPackage = async (storage: ArtifactStorage, checksum: string) => {
  const stored = await storage.get(key(checksum));

  if (stored.isErr()) throw stored.error;

  if (createHash("sha256").update(stored.value).digest("hex") !== checksum)
    throw new StorageUnavailable({ message: "Package artifact checksum mismatch", cause: null });

  return z.json().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.value)));
};
