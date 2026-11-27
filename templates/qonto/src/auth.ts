import { z } from "zod";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { Caller, Environment } from "./context.ts";
import { ensureUser } from "./database.ts";

/**
 * The scopes the offered methods need, and `offline_access` for a refresh
 * token. Trusting beneficiaries (`beneficiary.trust`) and reviewing requests
 * (`request_review.write`) are not requested: they would let a caller lift
 * Qonto's own approvals.
 */
export const scopes = [
  "offline_access",
  "organization.read",
  "subscription.read",
  "bank_account.write",
  "attachment.read",
  "attachment.write",
  "cash_flow_category.read",
  "cash_flow_category.write",
  "payment.write",
  "internal_transfer.write",
  "international_transfer.write",
  "request_transfers.write",
  "request_cards.write",
  "sepa_direct_debit.read",
  "sepa_direct_debit.write",
  "card.read",
  "card.write",
  "client.read",
  "client.write",
  "product.read",
  "product.write",
  "client_invoices.read",
  "client_invoice.write",
  "einvoicing.read",
  "supplier_invoice.read",
  "supplier_invoice.write",
  "payment_link.read",
  "payment_link.write",
  "terminal.read",
  "terminal.write",
  "membership.read",
  "membership.write",
  "team.read",
  "team.write",
  "insurance_contract.read",
  "insurance_contract.write",
  "webhook",
] as const;

/** The organization's own Qonto OAuth application. */
export type OAuthCredentials = { clientId: string; clientSecret: string };

// The member who authorized, in the organization they chose on Qonto's consent screen.
const membership = z.object({
  membership: z.object({
    id: z.string(),
    email: z.string(),
    first_name: z.string(),
    last_name: z.string(),
  }),
});

export const authentication = (
  environment: Environment,
  identity: Caller,
  id: string,
  credentials: OAuthCredentials,
) =>
  betterAuth({
    database: environment.DB,
    // Cookies are signed and saved tokens encrypted with the app's keys.
    keys: {
      sign: (value) => environment.WIDEFLEET_KEYS.sign("cookies", value),
      verify: (value, signature) => environment.WIDEFLEET_KEYS.verify("cookies", value, signature),
      encrypt: (value) => environment.WIDEFLEET_KEYS.encrypt("tokens", value),
      decrypt: async (value) =>
        new TextDecoder().decode(await environment.WIDEFLEET_KEYS.decrypt("tokens", value)),
    },
    baseURL: environment.WIDEFLEET_ORIGIN,
    basePath: "/auth",
    trustedOrigins: [environment.WIDEFLEET_ORIGIN],
    session: { expiresIn: 600, disableSessionRefresh: true },
    user: {
      additionalFields: { providerEmail: { type: "string", required: false } },
      validateUserInfo: async ({ user, source }) => {
        if (
          source.action !== "link-account" ||
          user.id !== id ||
          source.oauth?.providerId !== "qonto"
        )
          return { error: "invalid_linking_user" };

        const accountId = z.object({ id: z.string().min(1) }).parse(source.oauth.profile).id;

        const saved = await environment.DB.prepare(
          "SELECT accountId FROM account WHERE userId = ? AND providerId = ?",
        )
          .bind(id, "qonto")
          .first<string>("accountId");

        if (saved && saved !== accountId) return { error: "disconnect_before_switching_accounts" };

        return;
      },
    },
    account: {
      encryptOAuthTokens: true,
      storeAccountCookie: false,
      storeStateStrategy: "database",
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: true,
        allowUnlinkingAll: true,
        updateUserInfoOnLink: true,
        trustedProviders: ["qonto"],
      },
    },
    advanced: { cookiePrefix: "account_qonto" },
    plugins: [
      // Better Auth has no Qonto provider; Qonto's OAuth is plain OAuth 2.0.
      genericOAuth({
        config: [
          {
            providerId: "qonto",
            name: "Qonto",
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            authorizationUrl: "https://oauth.qonto.com/oauth2/auth",
            tokenUrl: "https://oauth.qonto.com/oauth2/token",
            scopes: [...scopes],
            // Qonto reads the client's credentials from the form body and rejects Basic authentication.
            authentication: "post",
            disableSignUp: true,
            getUserInfo: async (tokens) => {
              const response = await fetch("https://thirdparty.qonto.com/v2/membership", {
                headers: { authorization: `Bearer ${tokens.accessToken ?? ""}` },
              });

              if (!response.ok) return null;
              const member = membership.parse(await response.json()).membership;

              return {
                id: member.id,
                name: `${member.first_name} ${member.last_name}`.trim(),
                email: member.email,
                emailVerified: false,
              };
            },
            mapProfileToUser: (member) => ({ providerEmail: member.email ?? undefined }),
          },
        ],
      }),
      {
        id: "widefleet-caller",
        endpoints: {
          establishSession: createAuthEndpoint(
            "/widefleet-session",
            { method: "POST" },
            async (ctx) => {
              // Only called by app code using the platform-verified caller. The synthetic
              // email satisfies Better Auth's schema and is never used for account linking.
              await ensureUser(environment.DB, id, identity.name);
              const user = await ctx.context.internalAdapter.findUserById(id);
              const session = await ctx.context.internalAdapter.createSession(id);

              if (!user || !session) throw ctx.error("INTERNAL_SERVER_ERROR");
              await setSessionCookie(ctx, { user, session });

              return ctx.json({ established: true });
            },
          ),
        },
      },
    ],
  });
