// Test-only path adapter: Better Auth uses tenant-prefixed Microsoft endpoints,
// while emulate 0.12.1 exposes its authorize/token/JWKS routes without that prefix.
import { createEmulator } from "emulate";
import { createServer, request as forward } from "node:http";

const baseUrl = process.env["EMULATED_ENTRA_URL"] ?? "http://oidc.localhost:25433";

const tenant = "00000000-0000-4000-8000-000000000001";

const emulator = await createEmulator({
  service: "microsoft",
  hostname: "127.0.0.1",
  port: 25435,
  baseUrl,
  seed: {
    microsoft: {
      users: [
        { email: "sso@example.test", name: "SSO Test User", tenant_id: tenant },
        {
          email: "foreign@example.test",
          name: "Foreign Tenant User",
          tenant_id: "00000000-0000-4000-8000-000000000099",
        },
      ],
      oauth_clients: [
        {
          client_id: "00000000-0000-4000-8000-000000000002",
          client_secret: "local-test-only",
          name: "Platform integration tests",
          tenant_id: tenant,
          redirect_uris: [
            "https://auth.apps.localhost:25443/oauth2/callback",
            "http://localhost:25436/api/auth/callback/microsoft",
          ],
        },
      ],
    },
  },
});

const server = createServer((incoming, outgoing) => {
  const url = new URL(incoming.url ?? "/", baseUrl);

  if (url.pathname.startsWith("/echo")) {
    outgoing.setHeader("content-type", "application/json");
    outgoing.setHeader("set-cookie", "app_cookie=must-not-be-forwarded; Path=/; Secure; HttpOnly");
    outgoing.end(
      JSON.stringify({ method: incoming.method, headers: incoming.headers, url: incoming.url }),
    );

    return;
  }

  const path =
    url.pathname.replace(/^\/[a-f0-9-]{36}(?=\/(?:oauth2|discovery)\/)/, "") + url.search;

  const upstream = forward(
    {
      hostname: "127.0.0.1",
      port: 25435,
      path,
      method: incoming.method,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );

  upstream.on("error", () => outgoing.writeHead(502).end());
  incoming.pipe(upstream);
});

server.listen(25433, "0.0.0.0");

process.on("SIGTERM", () => {
  server.close();
  void emulator.close().then(() => process.exit(0));
});
