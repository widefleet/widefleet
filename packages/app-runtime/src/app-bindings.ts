import { env } from "cloudflare:workers";
import { config } from "./config.ts";
import { appProxy } from "./app-rpc.ts";
import type { AppService } from "./app-service.ts";
import { currentAppCaller } from "./app-context.ts";
import type { AppOAuth } from "./app-oauth.ts";
import type { OAuthRequest } from "./oauth-protocol.ts";

if ("WIDEFLEET_OAUTH_SERVICE" in env)
  Object.defineProperty(env, "WIDEFLEET_OAUTH", {
    value: {
      async request(input: OAuthRequest) {
        // SAFETY: The trusted loader binds this service to the current app and organization.
        const binding = (env as Record<string, AppOAuth>)["WIDEFLEET_OAUTH_SERVICE"];

        if (!binding) {
          if (input.action === "configuration") return null;
          throw new Error("Managed OAuth is not configured");
        }

        return binding.request(input, currentAppCaller());
      },
    },
    enumerable: true,
  });

const service = (name: string) => {
  // SAFETY: Only the trusted loader supplies these scoped bindings.
  const binding = (env as Record<string, AppService>)[`WIDEFLEET_SERVICE_${name}`];

  if (!binding) throw new Error("App binding is not initialized");

  return binding;
};

for (const name of config.capabilities ?? [])
  Object.defineProperty(env, name, {
    value: appProxy(
      (method, args) => service(name).invoke(method, args, currentAppCaller()),
      (request) => {
        const headers = new Headers(request.headers);
        const proof = currentAppCaller();
        headers.delete("x-widefleet-app-caller");

        if (proof) headers.set("x-widefleet-app-caller", proof);

        return service(name).fetch(new Request(request, { headers }));
      },
    ),
    enumerable: true,
    writable: true,
    configurable: true,
  });
