import { authRoute, authRouteKey } from "@platform/auth-proxy/publication";
import { sessionVersion } from "@platform/auth-proxy/configuration";
import { mcpClaims } from "@platform/contracts";
import type { ParentEnvironment } from "./types.ts";
import { mcpAccess, mcpAuthorizationServer, readMcpCompanyConfiguration } from "./mcp-oauth.ts";

export const verifyMcpToken = async (environment: ParentEnvironment, token: string) => {
  const { server, storage, resource } = mcpAuthorizationServer(environment);
  const verified = await server.validateToken<unknown>(resource, token, storage);

  if (!verified || !verified.scope.includes("mcp:services")) throw new Error("Invalid MCP token");
  const access = mcpAccess.parse(verified.props);

  const configuration = await readMcpCompanyConfiguration(
    environment,
    access.organizationId,
    access.provider,
  );

  if (access.version !== (await sessionVersion(configuration)) || access.expiresAt <= Date.now())
    throw new Error("Company authorization expired");

  return mcpClaims.parse({
    sub: verified.userId,
    scope: verified.scope.join(" "),
    exp: Math.min(verified.expiresAt, Math.floor(access.expiresAt / 1000)),
    mcp: {
      organizationId: access.organizationId,
      identity: access.identity,
      accountSubject: access.accountSubject,
    },
  });
};

export const serviceRoute = async (environment: ParentEnvironment, hostname: string) => {
  const stored = await environment.AUTH_CONFIG.get(authRouteKey(hostname));

  return stored ? authRoute.parse(JSON.parse(stored)) : null;
};
