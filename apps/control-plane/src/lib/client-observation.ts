import { browserAnalytics } from "./analytics-client.ts";
import type { ClientContext } from "./analytics-client.ts";
import { runExtensionEffect } from "./extension-effects.ts";

export const updateClientContext = (context: ClientContext) => {
  runExtensionEffect(() => browserAnalytics.update?.(context));
};

export const resetClientContext = () => {
  runExtensionEffect(() => browserAnalytics.reset?.());
};
