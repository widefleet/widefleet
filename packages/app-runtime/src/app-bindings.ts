import { env } from "cloudflare:workers";
import { config } from "./config.ts";
import { appProxy } from "./app-rpc.ts";
import type { AppService } from "./app-service.ts";

const service = (name: string) => {
  // SAFETY: Only the trusted loader supplies these scoped bindings.
  const binding = (env as Record<string, AppService>)[`WIDEFLEET_SERVICE_${name}`];

  if (!binding) throw new Error("App binding is not initialized");

  return binding;
};

for (const name of config.capabilities ?? [])
  Object.defineProperty(env, name, {
    value: appProxy(
      (method, args) => service(name).invoke(method, args),
      (request) => service(name).fetch(request),
    ),
    enumerable: true,
    writable: true,
    configurable: true,
  });
