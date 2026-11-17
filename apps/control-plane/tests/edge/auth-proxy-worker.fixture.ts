import { createAuthHandler, type AuthEnvironment } from "@platform/auth-proxy/worker";
import { authControlPath } from "@platform/auth-proxy/publication";
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
  async fetch(request: Request, input: z.infer<typeof environment> & AuthEnvironment) {
    const env = environment.parse(input);

    graphOrigin = env.GRAPH_ORIGIN;

    const worker = createAuthHandler(input, async (appRequest, appId) =>
      Response.json(
        {
          appId,
          url: appRequest.url,
          method: appRequest.method,
          headers: Object.fromEntries(appRequest.headers),
          body: await appRequest.text(),
        },
        {
          headers: {
            "set-cookie":
              "app_cookie=oauth; Domain=apps.example.test; Path=/; Secure; HttpOnly; SameSite=Lax",
          },
        },
      ),
    );

    if (new URL(request.url).pathname === "/_fixture/install") {
      const publish = (path: string, body: string) =>
        worker.fetch(
          new Request(`https://auth.invalid${authControlPath}${path}`, {
            method: "PUT",
            headers: {
              authorization: `Bearer ${input.WIDEFLEET_CONTROL_TOKEN}`,
              "content-type": "application/json",
            },
            body,
          }),
        );

      const installed = await publish("/organizations/widefleet/configuration", env.CONFIGURATION);

      if (!installed.ok) return installed;

      for (const [hostname, groups] of [
        ["ledger.apps.example.test", ["accounting"]],
        ["preview.ledger.apps.example.test", ["reviewers"]],
        ["ledger-pr42.apps.example.test", ["accounting"]],
        ["welcome.apps.example.test", []],
      ] as const) {
        const result = await publish(
          `/apps/${hostname}`,
          JSON.stringify({
            organizationId: "widefleet",
            appId: "00000000-0000-4000-8000-000000000003",
            access: { revision: 1, groups },
          }),
        );

        if (!result.ok) return result;
      }

      return new Response(null, { status: 204 });
    }

    // Route the local test socket to its synthetic public HTTPS origin. This is
    // a test-only envelope, never a trusted-header option in the auth proxy.
    const url = new URL(request.url);

    const publicUrl = new URL(
      url.pathname + url.search,
      request.headers.get("x-fixture-origin") ?? "https://auth.apps.example.test",
    );

    return worker.fetch(new Request(publicUrl, request));
  },
};
