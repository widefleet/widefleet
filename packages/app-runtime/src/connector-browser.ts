import { bindingName } from "@platform/contracts";
import { browserPolicy } from "./csp.ts";

export const browserEntrypoint = (pathname: string) => {
  const prefix = "/_widefleet/entrypoints/";

  if (!pathname.startsWith(prefix)) return "default";
  const match = /^([^/]+)\//.exec(pathname.slice(prefix.length));
  const parsed = bindingName.safeParse(match?.[1]);

  return parsed.success && parsed.data !== "default" ? parsed.data : null;
};

export const connectorBrowserResponse = (response: Response) => {
  const policy = response.headers.get("content-security-policy");
  const guarded = browserPolicy(response, []);

  // Preserve a connector's stricter policy alongside the platform baseline.
  if (policy) guarded.headers.append("content-security-policy", policy);

  const corsHeaders = [...guarded.headers.keys()].filter((name) =>
    name.startsWith("access-control-"),
  );

  for (const name of corsHeaders) guarded.headers.delete(name);
  guarded.headers.set("cross-origin-resource-policy", "same-origin");
  guarded.headers.set("x-content-type-options", "nosniff");
  guarded.headers.set("referrer-policy", "no-referrer");
  guarded.headers.set("cache-control", "private, no-store");

  return guarded;
};
