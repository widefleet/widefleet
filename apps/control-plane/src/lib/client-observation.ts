import { clientExtension } from "#client-extension";
import type { ClientContext } from "./client-extension.ts";

export const updateClientContext = (context: ClientContext) => {
  try {
    clientExtension.update?.(context);
  } catch {
    // Optional observation must not interrupt navigation.
  }
};

export const resetClientContext = () => {
  try {
    clientExtension.reset?.();
  } catch {
    // Signing out must remain possible when an extension fails.
  }
};
