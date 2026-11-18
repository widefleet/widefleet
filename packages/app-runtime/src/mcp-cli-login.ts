import { mcpCliLoginLifetime, signMcpCliLogin } from "@platform/auth-proxy/mcp-cli-login";
import type { ParentEnvironment } from "./types.ts";
import { verifyMcpToken } from "./mcp-authorization.ts";
import { readMcpLogin } from "./mcp-oauth.ts";

export const createMcpCliLogin = async (environment: ParentEnvironment, token: string) => {
  // Recheck the company authorization: a long MCP session must not mint codes after revocation.
  const claims = await verifyMcpToken(environment, token);
  const { platformUrl } = await readMcpLogin(environment);

  // Tokens issued before connections carried the account subject renew within minutes.
  if (!claims.mcp.accountSubject)
    throw new Error("Try again in a few minutes, or reconnect Widefleet in your client.");

  const code = await signMcpCliLogin(environment.WIDEFLEET_CONTROL_TOKEN, {
    organizationId: claims.mcp.organizationId,
    issuer: claims.mcp.identity.issuer,
    subject: claims.mcp.accountSubject,
  });

  return {
    command: `widefleet login --url ${platformUrl} --code ${code}`,
    expiresInSeconds: mcpCliLoginLifetime / 1000,
    note: "Run the command once before it expires. The code works only once; call cli_login again for a new one.",
  };
};
