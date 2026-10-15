import { authControlPath, authHostname, authRoute } from "@platform/auth-proxy/publication";
import type { z } from "zod";

export interface AuthProxyBindings {
  AUTH_PROXY?: {
    fetch: (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string | null },
    ) => Promise<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
      body: { cancel: () => Promise<void> } | null;
    }>;
  };
  AUTH_PROXY_KEY?: string;
}

export const authProxyRequest = async (
  bindings: AuthProxyBindings,
  path: string,
  method: string,
  body?: string,
) => {
  if (!bindings.AUTH_PROXY || !bindings.AUTH_PROXY_KEY)
    throw new Error("Auth proxy binding or key is missing");

  const response = await bindings.AUTH_PROXY.fetch(
    `https://auth.invalid${authControlPath}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${bindings.AUTH_PROXY_KEY}`,
        "content-type": "application/json",
      },
      body: body ?? null,
    },
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The auth proxy could not apply its configuration (HTTP ${response.status})`);
  }

  return response;
};

export const publishAuthRoute = async (
  bindings: AuthProxyBindings,
  hostname: string,
  route: z.infer<typeof authRoute>,
) => {
  await authProxyRequest(
    bindings,
    `/apps/${authHostname.parse(hostname)}`,
    "PUT",
    JSON.stringify(authRoute.parse(route)),
  );
};

export const removeAuthRoute = async (bindings: AuthProxyBindings, hostname: string) => {
  await authProxyRequest(bindings, `/apps/${authHostname.parse(hostname)}`, "DELETE");
};
