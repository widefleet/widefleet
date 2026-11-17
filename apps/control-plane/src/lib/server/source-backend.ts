import type { z } from "zod";
import { StorageUnavailable } from "./errors.ts";
import type { sourceCredential } from "@platform/contracts";

export interface SourceBackend {
  repository: (id: string) => Promise<{ url: string } | null>;
  create: (id: string) => Promise<{ url: string }>;
  head: (id: string, branch: string) => Promise<string | null>;
  hasCommit: (id: string, commit: string) => Promise<boolean>;
  credential: (id: string, scope: "read" | "write") => Promise<z.infer<typeof sourceCredential>>;
  remove: (id: string) => Promise<void>;
}

export const sourceOperation = async <T>(operation: () => Promise<T>) => {
  try {
    return await operation();
  } catch (cause) {
    throw new StorageUnavailable({ message: "The source repository is unavailable", cause });
  }
};
