import { authConfiguration, createAuthProxy } from "@platform/auth-proxy";
import { z } from "zod";

const environment = z.object({
  CONFIGURATION: z.string(),
  GRAPH_ORIGIN: z.string(),
});

const outgoing = globalThis.fetch;

// Only this disposable fixture reroutes Graph to the local identity provider.
// The production proxy still validates the real Graph origin before fetching.
let graphOrigin = "";

globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);

  if (url.origin === "https://graph.microsoft.com") {
    return outgoing(new Request(new URL(url.pathname + url.search, graphOrigin), request));
  }

  return outgoing(request);
};

export default {
  async fetch(request: Request, input: z.infer<typeof environment>) {
    const env = environment.parse(input);

    graphOrigin = env.GRAPH_ORIGIN;
    const configuration = authConfiguration.parse(JSON.parse(env.CONFIGURATION));

    const routes = new Map([
      ["ledger.apps.example.test", { revision: 1, groups: ["accounting"] }],
      ["preview.ledger.apps.example.test", { revision: 1, groups: ["reviewers"] }],
      ["ledger-pr42.apps.example.test", { revision: 1, groups: ["accounting"] }],
      ["welcome.apps.example.test", { revision: 0, groups: [] }],
    ]);

    const proxy = createAuthProxy(configuration, {
      resolve: (hostname) => Promise.resolve(routes.get(hostname) ?? null),
      fetch: async (forwarded) =>
        Response.json(
          {
            url: forwarded.url,
            method: forwarded.method,
            headers: Object.fromEntries(forwarded.headers),
            body: await forwarded.text(),
          },
          { headers: { "set-cookie": "app_cookie=blocked; Path=/" } },
        ),
    });

    // Route the local test socket to its synthetic public HTTPS origin. This is
    // a test-only envelope, never a trusted-header option in the auth proxy.
    const url = new URL(request.url);

    const publicUrl = new URL(
      url.pathname + url.search,
      request.headers.get("x-fixture-origin") ?? "https://auth.apps.example.test",
    );

    return proxy.fetch(new Request(publicUrl, request));
  },
};
