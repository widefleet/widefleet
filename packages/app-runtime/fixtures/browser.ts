// Synthetic app that tries to opt out of platform CSP and records resource requests.
export default {
  async fetch(request: Request, env: { KV: KVNamespace; ASSETS: Fetcher }) {
    const url = new URL(request.url);

    if (url.pathname === "/observed") {
      const entries = await env.KV.list({ prefix: `${url.searchParams.get("phase")}:` });

      return Response.json(entries.keys.map((entry) => entry.name));
    }

    if (url.pathname.startsWith("/resource/")) {
      const kind = url.pathname.slice("/resource/".length);
      await env.KV.put(
        `${url.searchParams.get("phase")}:${url.searchParams.get("destination") ?? url.host}:${kind}`,
        "received",
      );
      const headers = { "access-control-allow-origin": "*", "cache-control": "no-store" };

      if (kind === "image")
        return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', {
          headers: { ...headers, "content-type": "image/svg+xml" },
        });

      // Font decoding is immaterial here: the test observes whether the browser
      // makes the request and whether a CSP violation prevents it from reaching us.
      if (kind === "font")
        return new Response("synthetic font bytes", {
          headers: { ...headers, "content-type": "font/woff2" },
        });

      return new Response("fixture", { headers });
    }

    if (url.pathname === "/static.html") return env.ASSETS.fetch(request);

    return new Response("<!doctype html><title>Network fixture</title><p>Network fixture</p>", {
      headers: {
        "content-type": "text/html",
        "content-security-policy": "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
      },
    });
  },
};
