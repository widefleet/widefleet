import type { AnalyticsConfiguration } from "../analytics-config.ts";

export const proxyAnalyticsRequest = async (
  request: Request,
  config: AnalyticsConfiguration | null,
  transport: typeof fetch = fetch,
): Promise<Response | undefined> => {
  const url = new URL(request.url);

  if (!config || !url.pathname.startsWith(`${config.proxyPath}/`)) return undefined;

  if (url.origin !== config.origin) return new Response("Not found", { status: 404 });
  const path = url.pathname.slice(config.proxyPath.length);

  if (!/^\/(?:static\/|array\/|e\/|i\/v0\/e\/|s\/|flags\/)/.test(path))
    return new Response("Not found", { status: 404 });

  if (!["GET", "POST"].includes(request.method)) return new Response(null, { status: 405 });

  url.hostname =
    path.startsWith("/static/") || path.startsWith("/array/")
      ? "eu-assets.i.posthog.com"
      : "eu.i.posthog.com";
  url.protocol = "https:";
  url.port = "";
  url.pathname = path;
  const headers = new Headers();

  for (const name of ["content-type", "content-encoding", "accept"]) {
    const value = request.headers.get(name);

    if (value) headers.set(name, value);
  }

  headers.set("accept-encoding", "identity");

  try {
    const options = {
      method: request.method,
      headers,
      body: request.body,
      duplex: "half",
      redirect: "manual" as const,
      signal: AbortSignal.timeout(10_000),
    };

    const response = await transport(url, options);

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();

      return new Response(null, { status: 502 });
    }

    const outgoing = new Headers(response.headers);
    outgoing.delete("set-cookie");

    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch {
    return new Response(null, { status: 502 });
  }
};
