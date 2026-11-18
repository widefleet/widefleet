import { and, eq, gt, isNull, like, lt } from "drizzle-orm";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { mcpCliLoginOrganization, type mcpCliLogin } from "@platform/auth-proxy/mcp-cli-login";
import { providerIssuer } from "../company-identity.ts";
import type { OrganizationAccess } from "./application-context.ts";
import { account, deviceCode, member, verification } from "./auth-schema.ts";
import { cliClientId } from "./auth-options.ts";
import { authenticationReference } from "./authentication-context.ts";
import type { Configuration } from "./config.ts";
import type { DatabaseExecutor } from "./database.ts";
import type { companyIdentity } from "./company-identity.ts";

const prefix = "mcp-cli-login:";

const invalidCode = () =>
  new APIError("BAD_REQUEST", {
    message: "This login code is invalid, expired or already used. Run cli_login again.",
  });

// Declared rather than derived from the settings service: authentication types
// feed the services that settings depend on.
export interface CliLoginSettings {
  resolve(organizationId: string): Promise<{
    identity: z.infer<typeof companyIdentity> | null;
    sso: { providerId: string } | null;
  }>;
  verifyCliLogin(organizationId: string, code: string): Promise<z.infer<typeof mcpCliLogin> | null>;
}

// Signs a CLI in as the user behind an MCP authorization. The MCP server signs a
// short-lived code; the edge verifies it here and this approves the CLI's own
// device request, so token issuance stays on the normal device grant.
export const createMcpCliLogin = (
  database: DatabaseExecutor,
  configuration: Configuration,
  settings: CliLoginSettings,
  access?: OrganizationAccess,
) => {
  const resolveUser = async (login: z.infer<typeof mcpCliLogin>) => {
    const { identity, sso } = await settings.resolve(login.organizationId);

    // Without required company SSO, Widefleet is the organization's app identity provider.
    if (!identity) {
      if (login.issuer !== `${configuration.PLATFORM_URL}/api/auth`) return null;

      return login.subject;
    }

    if (!sso || providerIssuer(identity.provider) !== login.issuer) return null;

    // Company SSO keys accounts by the subject of the organization's registration,
    // the same registration that signed in the MCP connection.
    const users = await database
      .select({ userId: account.userId })
      .from(account)
      .where(and(eq(account.providerId, sso.providerId), eq(account.accountId, login.subject)));

    return users.length === 1 ? (users[0]?.userId ?? null) : null;
  };

  return {
    async redeem(code: string, userCode: string) {
      const organizationId = mcpCliLoginOrganization(code);

      if (!organizationId) throw invalidCode();
      const login = await settings.verifyCliLogin(organizationId, code);

      if (!login || login.organizationId !== organizationId) throw invalidCode();
      const userId = await resolveUser(login);

      const [membership] = userId
        ? await database
            .select({ id: member.id })
            .from(member)
            .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
        : [];

      if (
        !userId ||
        !membership ||
        (access &&
          !(await access.filterOrganizations([{ id: organizationId }])).includes(organizationId))
      )
        throw new APIError("FORBIDDEN", {
          message:
            "No Widefleet account matches this sign-in. Sign in to Widefleet in the browser once, then run cli_login again.",
        });

      await database.transaction(async (transaction) => {
        await transaction
          .delete(verification)
          .where(and(like(verification.id, `${prefix}%`), lt(verification.expiresAt, new Date())));

        const used = await transaction
          .insert(verification)
          .values({
            id: prefix + login.id,
            identifier: prefix + login.id,
            value: "",
            expiresAt: new Date(login.expiresAt),
          })
          .onConflictDoNothing()
          .returning({ id: verification.id });

        // Expired use records are removed above, so an expired code must not claim its ID again.
        if (!used.length || login.expiresAt <= Date.now()) throw invalidCode();

        const approved = await transaction
          .update(deviceCode)
          .set({
            status: "approved",
            userId,
            // A company login authorizes only its own organization, like an SSO session.
            referenceId: authenticationReference(userId, organizationId),
            sessionId: null,
            authTime: new Date(),
          })
          .where(
            and(
              eq(deviceCode.userCode, userCode),
              eq(deviceCode.status, "pending"),
              eq(deviceCode.oauthClientId, cliClientId),
              isNull(deviceCode.userId),
              gt(deviceCode.expiresAt, new Date()),
            ),
          )
          .returning({ id: deviceCode.id });

        if (!approved.length)
          throw new APIError("BAD_REQUEST", {
            message:
              "The CLI's device login is unknown, expired or already used. Run the command again.",
          });
      });

      return { success: true };
    },
  };
};

export const mcpCliLoginPlugin = (login: ReturnType<typeof createMcpCliLogin>) => ({
  id: "mcp-cli-login",
  // Hosted installations provide one Cloudflare binding per policy; reuse an existing one.
  rateLimit: [{ pathMatcher: (path: string) => path === "/mcp/cli-login", window: 60, max: 5 }],
  endpoints: {
    redeemMcpCliLogin: createAuthEndpoint(
      "/mcp/cli-login",
      {
        method: "POST",
        body: z.object({ code: z.string().max(4096), user_code: z.string().min(1).max(128) }),
      },
      async (context) => {
        context.setHeader("cache-control", "no-store");

        return context.json(await login.redeem(context.body.code, context.body.user_code));
      },
    ),
  },
});
