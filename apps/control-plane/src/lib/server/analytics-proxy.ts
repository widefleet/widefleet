import type { AnalyticsConfiguration } from "../analytics-config.ts";

const maxBodyBytes = 5 * 1024 * 1024;

const readBody = async (request: Request) => {
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return null;

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > maxBodyBytes) {
        await reader.cancel();

        return null;
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
};

export const proxyAnalyticsRequest = async (
  request: Request,
  config: AnalyticsConfiguration | null,
  transport: typeof fetch = fetch,
): Promise<Response | undefined> => {
  if (!config) return undefined;
  const url = new URL(request.url);

  if (url.pathname !== config.proxyPath && !url.pathname.startsWith(`${config.proxyPath}/`))
    return undefined;

  if (url.origin !== config.origin) return new Response("Not found", { status: 404 });

  const path = url.pathname.slice(config.proxyPath.length);
  const asset = /^\/static\/[a-zA-Z0-9_./-]+\.js$/.test(path);

  const projectConfig =
    path === `/array/${config.projectToken}/config` ||
    path === `/array/${config.projectToken}/config.js`;

  const ingest = /^\/(?:e|i\/v0\/e|s|flags)\/$/.test(path);

  if ((!asset && !projectConfig && !ingest) || path.includes("..") || path.includes("//"))
    return new Response("Not found", { status: 404 });

  if (request.method !== "GET" && request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });

  if ((asset || projectConfig) && request.method !== "GET")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  const origin = request.headers.get("origin");

  if (
    (origin && origin !== config.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return new Response("Forbidden", { status: 403 });

  const target = new URL(path, asset || projectConfig ? config.assetOrigin : config.ingestOrigin);
  target.search = url.search;
  // Only protocol headers cross the proxy. Session cookies, bearer credentials,
  // referrers and forwarded IP headers belong to the application, never PostHog.
  const headers = new Headers();

  for (const name of ["content-type", "content-encoding", "accept"]) {
    const value = request.headers.get(name);

    if (value) headers.set(name, value);
  }

  headers.set("accept-encoding", "identity");

  try {
    const body = request.method === "POST" ? await readBody(request) : undefined;

    if (body === null) return new Response("Payload too large", { status: 413 });

    const options: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    };

    if (body) options.body = body;
    const response = await transport(target, options);

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();

      return new Response("Analytics unavailable", { status: 502 });
    }

    const outgoing = new Headers({ "x-content-type-options": "nosniff" });
    const contentType = response.headers.get("content-type");

    if (contentType) outgoing.set("content-type", contentType);
    outgoing.set("cache-control", asset && response.ok ? "public, max-age=3600" : "no-store");

    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch {
    return new Response("Analytics unavailable", { status: 502 });
  }
};
