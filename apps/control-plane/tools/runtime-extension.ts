import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  createRuntimeExtension,
  type RuntimeExtensionContext,
} from "../src/lib/server/runtime-extension.ts";

// Source-run operator commands use the same module selected by the build alias.
export const loadRuntimeExtension = async (context: RuntimeExtensionContext) => {
  const path = process.env["WIDEFLEET_RUNTIME_EXTENSION"];

  if (!path) return createRuntimeExtension(context);

  if (!isAbsolute(path))
    throw new Error("WIDEFLEET_RUNTIME_EXTENSION must be an absolute module path");

  const extension = z
    .object({
      createRuntimeExtension: z.custom<typeof createRuntimeExtension>(
        (value) => value instanceof Function,
      ),
    })
    .parse(await import(pathToFileURL(path).href));

  return extension.createRuntimeExtension(context);
};
