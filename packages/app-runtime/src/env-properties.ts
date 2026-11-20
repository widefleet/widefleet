import { env } from "cloudflare:workers";
import { mergeEnvironment } from "./env-merge.ts";

/**
 * The platform adds bindings to an app's importable `env` when the app loads:
 * D1, R2 and KV facades, managed OAuth and app connections. Cloudflare's Worker
 * Loader can hand an entrypoint a different environment object than that one,
 * so apps reading `this.env` or a handler's `env` would miss them. Entrypoints
 * pass apps the environment this returns, which has the properties of both.
 */
export const withEnvProperties = <T extends object>(target: T): T => mergeEnvironment(env, target);
