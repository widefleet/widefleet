import {
  oauthDeviceAuthorization,
  oauthProvider,
  type OAuthClaimExtensionInput,
} from "@better-auth/oauth-provider";
import type { BetterAuthOptions } from "better-auth";
import { emailOTP, jwt, organization, oneTimeToken } from "better-auth/plugins";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { z } from "zod";
import type { Configuration } from "./config.ts";
import { createSignInEmail, sendOrganizationInvitation, type SendEmail } from "./email.ts";
import { hashAppClientSecret } from "./app-login-client.ts";
import { authenticationReference } from "./authentication-context.ts";
import { organizationAccess, organizationRoles } from "../organization.ts";

export const cliClientId = "platform-cli";

export const cliScopes = [
  "openid",
  "profile",
  "offline_access",
  "platform:read",
  "platform:write",
  "network:manage",
];

export const apiResource = (configuration: Configuration) => `${configuration.PLATFORM_URL}/api/v1`;

export const cliResourcePolicy = (configuration: Configuration) => ({
  identifier: apiResource(configuration),
  allowedScopes: cliScopes,
  accessTokenTtl: 300,
});

export const authenticationOptions = (
  configuration: Configuration,
  {
    initializeResources = false,
    sendEmail,
    allowEmail,
    tokenClaims,
    rateLimit,
    ipAddressHeaders,
  }: {
    initializeResources?: boolean;
    sendEmail?: SendEmail;
    allowEmail?: (email: string) => Promise<boolean>;
    tokenClaims?: (
      input: OAuthClaimExtensionInput,
    ) => Promise<{ reference_id: string; organization_id?: string }>;
    rateLimit?: BetterAuthOptions["rateLimit"];
    ipAddressHeaders?: string[];
  } = {},
) => {
  const sendSignInEmail = createSignInEmail(configuration, sendEmail);

  return {
    appName: "Widefleet",
    baseURL: configuration.PLATFORM_URL,
    secret: configuration.BETTER_AUTH_SECRET,
    trustedOrigins: [configuration.PLATFORM_URL],
    // Membership mutations use the shared organization services for UI, API and CLI.
    disabledPaths: [
      "/sign-up/email",
      "/sign-in/email",
      "/request-password-reset",
      "/reset-password",
      "/set-password",
      "/change-password",
      "/one-time-token/generate",
      "/organization/create",
      "/organization/update",
      "/organization/delete",
      "/organization/remove-member",
      "/organization/leave",
      "/organization/invite-member",
      "/organization/accept-invitation",
      "/organization/reject-invitation",
      "/organization/cancel-invitation",
      "/organization/update-member-role",
      "/email-otp/get-verification-otp",
      "/email-otp/check-verification-otp",
      "/email-otp/verify-email",
      "/email-otp/request-password-reset",
      "/email-otp/reset-password",
      "/email-otp/request-email-change",
      "/email-otp/change-email",
      "/forget-password/email-otp",
    ],
    hooks: {
      before: createAuthMiddleware(async (context) => {
        const accountPaths = [
          "/link-social",
          "/unlink-account",
          "/get-access-token",
          "/refresh-token",
          "/list-accounts",
          "/list-sessions",
          "/revoke-session",
          "/revoke-sessions",
          "/revoke-other-sessions",
          "/update-user",
          "/delete-user",
          "/change-email",
        ];

        const current =
          ["/device/approve", "/device/deny"].includes(context.path) ||
          accountPaths.includes(context.path)
            ? await getSessionFromCtx(context)
            : null;

        const identityOrganizationId = z
          .string()
          .nullable()
          .parse(current?.session["identityOrganizationId"] ?? null);

        if (identityOrganizationId !== null) {
          if (
            ["/link-social", "/unlink-account", "/get-access-token", "/refresh-token"].includes(
              context.path,
            )
          ) {
            throw new APIError("FORBIDDEN", {
              message: "Company accounts are managed through organization SSO settings",
            });
          } else if (
            [
              "/list-accounts",
              "/list-sessions",
              "/revoke-session",
              "/revoke-sessions",
              "/revoke-other-sessions",
              "/update-user",
              "/delete-user",
              "/change-email",
            ].includes(context.path)
          )
            throw new APIError("FORBIDDEN", {
              message: "Sign in with your Widefleet email to manage your global account",
            });
        }

        if (
          context.path === "/email-otp/send-verification-otp" ||
          context.path === "/sign-in/email-otp"
        ) {
          if (!sendSignInEmail || !allowEmail)
            throw new APIError("FORBIDDEN", { message: "Email sign-in is not configured" });

          const input = z
            .object({ email: z.email(), type: z.literal("sign-in").optional() })
            .parse(context.body);

          if (!(await allowEmail(input.email.toLowerCase()))) {
            if (context.path === "/email-otp/send-verification-otp")
              return context.json({ success: true });
            throw new APIError("UNAUTHORIZED", { message: "Invalid or expired sign-in code" });
          }
        }

        if (!["/device/approve", "/device/deny"].includes(context.path)) return undefined;
        const approvalSession = context.headers?.get("x-widefleet-approval-session");

        if (approvalSession && approvalSession !== current?.session.id)
          throw new APIError("FORBIDDEN", {
            error: "access_denied",
            error_description: "Your sign-in changed. Reload this page before connecting the CLI.",
          });

        if (context.path !== "/device/approve") return undefined;

        if (current?.session["recovery"] === true)
          throw new APIError("FORBIDDEN", {
            message:
              "Sign in with your company account before authorizing a CLI. Recovery access cannot create long-lived credentials.",
          });

        return undefined;
      }),
    },
    account: {
      accountLinking: {
        enabled: true,
        // The SSO plugin grants linking trust only after verified domain ownership.
        allowDifferentEmails: false,
        // The bootstrap owner has no email verification before SSO is configured.
        // Its matching address is proven by the verified-domain provider instead.
        requireLocalEmailVerified: false,
      },
    },
    session: {
      additionalFields: {
        identityOrganizationId: { type: "string", required: false, input: false },
        recovery: { type: "boolean", defaultValue: false, input: false },
        companyConfiguration: { type: "string", defaultValue: "", input: false },
      },
    },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      ipAddress: { ipAddressHeaders: ipAddressHeaders ?? ["x-forwarded-for"] },
      cookiePrefix: "platform",
      crossSubDomainCookies: { enabled: false },
      // Keep browser protection enabled in integration tests too; Better Auth's
      // test-environment defaults otherwise skip these checks.
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    rateLimit: rateLimit ?? { storage: "memory" },
    plugins: [
      emailOTP({
        storeOTP: "hashed",
        expiresIn: 300,
        allowedAttempts: 3,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (!sendSignInEmail || type !== "sign-in")
            throw new APIError("FORBIDDEN", { message: "Email sign-in is not configured" });
          await sendSignInEmail({
            to: email,
            subject: "Your Widefleet sign-in code",
            text: `Your Widefleet sign-in code is ${otp}.\n\nIt expires in five minutes. If you did not request it, you can ignore this email.`,
          });
        },
      }),
      oneTimeToken({ expiresIn: 10, storeToken: "hashed", disableClientRequest: true }),
      organization({
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        requireEmailVerificationOnInvitation: true,
        ac: organizationAccess,
        roles: organizationRoles,
        sendInvitationEmail: async ({ id, email, organization }) =>
          sendOrganizationInvitation(sendEmail, configuration.PLATFORM_URL, {
            id,
            email,
            organizationName: organization.name,
          }),
      }),
      jwt({ jwt: { issuer: `${configuration.PLATFORM_URL}/api/auth` } }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/device",
        postLogin: {
          page: "/organizations",
          shouldRedirect: () => false,
          consentReferenceId: ({ user, session }) => {
            if (session["recovery"] === true)
              throw new APIError("FORBIDDEN", {
                message: "Recovery cannot authorize long-lived access",
              });

            return authenticationReference(
              user.id,
              z
                .string()
                .nullable()
                .parse(session["identityOrganizationId"] ?? null),
            );
          },
        },
        extensions: tokenClaims
          ? [{ claims: { accessToken: tokenClaims, idToken: tokenClaims } }]
          : [],
        scopes: [...cliScopes, "email"],
        storeClientSecret: { hash: hashAppClientSecret },
        customIdTokenClaims: ({ user, scopes }) => ({
          email: scopes.includes("email") ? user.email : undefined,
          email_verified: scopes.includes("email") ? user.emailVerified : undefined,
          name: scopes.includes("profile") ? user.name : undefined,
        }),
        // Request-scoped instances read the policies persisted by installation setup.
        resources: initializeResources ? [cliResourcePolicy(configuration)] : [],
        resourceSeedMode: "overwrite",
        enforcePerClientResources: true,
        allowDynamicClientRegistration: false,
        clientPrivileges: () => false,
        resourcePrivileges: () => false,
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        // Browser app requests may refresh the same cookie concurrently.
        refreshTokenReuseInterval: 30,
      }),
      oauthDeviceAuthorization({ verificationUri: `${configuration.PLATFORM_URL}/device` }),
    ],
  } satisfies BetterAuthOptions;
};
