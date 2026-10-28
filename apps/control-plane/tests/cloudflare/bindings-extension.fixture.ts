import { z } from "zod";
import type { RuntimeExtensionContext } from "../../src/lib/server/runtime-extension.ts";

export const createRuntimeExtension = ({ binding, observation }: RuntimeExtensionContext) => {
  if (!binding || !observation) throw new Error("Missing extension initialization context");
  binding("FIXTURE_EXTENSION_SECRET", z.literal("synthetic-extension-secret"));
  binding("FIXTURE_EXTENSION_MODE", z.literal("enabled"));

  return {};
};
