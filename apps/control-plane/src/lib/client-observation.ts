import { clientExtension } from "#client-extension";
import type { ClientContext } from "./client-extension.ts";
import { runExtensionEffect } from "./extension-effects.ts";

export const updateClientContext = (context: ClientContext) => {
  runExtensionEffect(() => clientExtension.update?.(context));
};

export const resetClientContext = () => {
  runExtensionEffect(() => clientExtension.reset?.());
};
