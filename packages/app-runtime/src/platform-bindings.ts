import { env } from "cloudflare:workers";
import { bindingRegistry } from "./binding-registry.ts";

export const platformBindings = bindingRegistry();

/**
 * Returns the environment to pass to app code for this invocation. It also
 * completes the importable env, which Cloudflare points at the current
 * request's environment.
 */
export const withBindings = <T extends object>(target: T): T => {
  platformBindings.install(env);

  return platformBindings.apply(target);
};
