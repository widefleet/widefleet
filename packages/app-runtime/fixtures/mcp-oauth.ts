import { base64url } from "jose";
import { z } from "zod";
import { sessionVersion } from "@platform/auth-proxy/configuration";
import { encodeMcpLogin, mcpLoginKey } from "@platform/auth-proxy/mcp-login";
import { appAccessSnapshot } from "@platform/contracts";
import { mcpAuthorizationServer, readMcpOrganization } from "../src/mcp-oauth.ts";
import { mcpLoginRequest } from "../src/mcp-login.ts";
import type { ParentEnvironment } from "../src/types.ts";

// Test-only grant issuer. Production completes these grants after company sign-in.
export const mcpFixture = async (
  request: Request,
  environment: ParentEnvironment,
  context: ExecutionContext,
) => {
  const path = new URL(request.url).pathname;

  if (path === "/mcp-setup") {
    const input = z
      .object({ hostname: z.string(), appId: z.uuid(), access: appAccessSnapshot })
      .parse(await request.json());

    await environment.AUTH_CONFIG.put(
      `apps/${input.hostname}`,
      JSON.stringify({
        organizationId: "widefleet",
        appId: input.appId,
        access: input.access,
      }),
    );

    return Response.json(true);
  }

  if (!["/mcp-issue", "/mcp-revoke", "/mcp-sign-in"].includes(path)) return null;
  const { server, storage, oauth, issuer, resource } = mcpAuthorizationServer(environment);

  if (path === "/mcp-revoke") {
    const { token } = z.object({ token: z.string() }).parse(await request.json());
    const [user, grant] = token.split(":");
    await oauth.revokeGrant(z.string().parse(grant), z.string().parse(user));

    return Response.json(true);
  }

  const configuration = await readMcpOrganization(environment, "widefleet");

  const client = await oauth.createClient({
    clientName: "Local test client",
    redirectUris: ["https://client.example.test/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });

  const verifier = crypto.randomUUID() + crypto.randomUUID();

  const challenge = base64url.encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

  const parameters = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0] ?? "",
    response_type: "code",
    resource,
    scope: "mcp:services",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  if (path === "/mcp-sign-in") {
    await environment.AUTH_CONFIG.put(
      mcpLoginKey,
      await encodeMcpLogin(environment.WIDEFLEET_CONTROL_TOKEN, {
        origin: issuer,
        platformUrl: "https://platform.example.test",
      }),
    );

    return mcpLoginRequest(
      new Request(`${issuer}/authorize?${parameters.toString()}`),
      environment,
      context,
    );
  }

  const input = z
    .object({ subject: z.string(), groups: z.array(z.string()) })
    .parse(await request.json());

  const original = await oauth.parseAuthRequest(
    new Request(`${issuer}/authorize?${parameters.toString()}`),
  );

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: input.subject,
    scope: ["mcp:services"],
    metadata: {},
    props: {
      organizationId: "widefleet",
      credential: {
        version: await sessionVersion(configuration),
        authorization: {
          subject: input.subject,
          expiresAt: Date.now() + 3600_000,
          identity: {
            id: input.subject,
            name: "Alice",
            email: "alice@example.test",
            groups: input.groups,
          },
        },
      },
    },
  });

  return server.fetch(
    new Request(`${issuer}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        redirect_uri: client.redirectUris[0] ?? "",
        code: new URL(redirectTo).searchParams.get("code") ?? "",
        code_verifier: verifier,
        resource,
      }),
    }),
    storage,
    context,
  );
};
