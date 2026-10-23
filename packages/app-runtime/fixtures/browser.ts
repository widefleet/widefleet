// Synthetic app that tries to opt out of platform CSP.
export default {
  fetch(request: Request, env: { ASSETS: Fetcher }) {
    const url = new URL(request.url);

    if (url.pathname === "/static.html") return env.ASSETS.fetch(request);

    return new Response("<!doctype html><title>Network fixture</title><p>Network fixture</p>", {
      headers: {
        "content-type": "text/html",
        "content-security-policy": "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
      },
    });
  },
};
