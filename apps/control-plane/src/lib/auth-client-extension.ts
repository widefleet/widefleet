import type { BetterAuthClientPlugin } from "better-auth";

export interface AuthClientExtension {
  // Request middleware does not change the shared client's typed endpoints.
  plugins?: Pick<BetterAuthClientPlugin, "id" | "fetchPlugins">[];
  mountEmailCodeForm?: (element: HTMLElement) => () => void;
}

export const authClientExtension: AuthClientExtension = {};
