import {
  oauthDeviceAuthorization,
  oauthProvider,
  type OAuthClaimExtensionInput,
} from "@better-auth/oauth-provider";
import type { BetterAuthOptions } from "better-auth";
import { emailOTP, jwt, organization, oneTimeToken, lastLoginMethod } from "better-auth/plugins";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { z } from "zod";
import type { Configuration } from "./config.ts";
import type { AuthenticationExtension } from "./runtime-extension.ts";
import { createSignInEmail, sendOrganizationInvitation, type SendEmail } from "./email.ts";
import { hashAppClientSecret } from "./app-login-client.ts";
import { authenticationReference } from "./authentication-context.ts";
import type { SignIn } from "./sso-policy.ts";
import { organizationAccess, organizationRoles } from "../organization.ts";
import { organizationMemberLimit } from "./organization.ts";
import { personalSocialAccounts, socialProviders, validateSocialUser } from "./social-sign-in.ts";
import { signInPicture, type SavePicture } from "./sign-in-picture.ts";

export const cliClientId = "platform-cli";

export const cliScopes = [
  "openid",
  "profile",
  "offline_access",
  "platform:read",
  "platform:write",
  "network:manage",
];

// Clients continue with the named provider, as when the email field finds it.
export const companySsoRequired = (providerId: string) =>
  new APIError("FORBIDDEN", {
    code: "COMPANY_SSO_REQUIRED",
    message: "Your organization signs you in with company SSO",
    providerId,
  });

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
    allowUser,
    signInLimit,
    domainSsoProvider,
    tokenClaims,
    rateLimit,
    ipAddressHeaders,
    publicSignup = false,
    validateSchema,
    savePicture,
  }: {
    initializeResources?: boolean;
    sendEmail?: SendEmail;
    allowEmail?: (email: string) => Promise<boolean>;
    allowUser?: AuthenticationExtension["allowUser"];
    signInLimit?: (signIn: SignIn) => Promise<string | null>;
    domainSsoProvider?: (email: string) => Promise<{ providerId: string } | null>;
    tokenClaims?: (
      input: OAuthClaimExtensionInput,
    ) => Promise<{ reference_id: string; organization_id?: string }>;
    rateLimit?: BetterAuthOptions["rateLimit"];
    ipAddressHeaders?: string[];
    publicSignup?: boolean;
    /** Better Auth checks the schema the first time each instance is used. */
    validateSchema?: boolean;
    /** Keeps the picture each provider sign-in reports. */
    savePicture?: SavePicture;
  } = {},
) => {
  const sendSignInEmail = createSignInEmail(configuration, sendEmail);

  const picture = (image: string | null | undefined) =>
    image ? new URL(image, configuration.PLATFORM_URL).href : undefined;

  const providers = socialProviders(configuration);

  if (publicSignup && (!sendEmail || configuration.LOGIN_CODE_DELIVERY !== "email"))
    throw new Error("Public signup requires email delivery");

  return {
    appName: "Widefleet",
    baseURL: configuration.PLATFORM_URL,
    secret: configuration.BETTER_AUTH_SECRET,
    secrets: configuration.BETTER_AUTH_SECRETS,
    trustedOrigins: [configuration.PLATFORM_URL],
    socialProviders: providers,
    user: Object.keys(providers).length
      ? {
          validateUserInfo: validateSocialUser(allowEmail, allowUser, domainSsoProvider),
        }
      : undefined,
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
          // Session lookups are not checked on each request: an extension that blocks a user ends
          // their sessions, and new sessions are checked when they are created.
          (allowUser && context.path === "/token") ||
          ["/device/approve", "/device/deny"].includes(context.path) ||
          accountPaths.includes(context.path)
            ? await getSessionFromCtx(context)
            : null;

        if (current && allowUser && !(await allowUser(current.user.id)))
          throw new APIError("FORBIDDEN", { message: "This account is unavailable" });

        if (
          context.path === "/link-social" &&
          ["widefleet-google", "widefleet-microsoft"].includes(
            z.object({ provider: z.string() }).parse(context.body).provider,
          ) &&
          (!current?.user.emailVerified ||
            current.session["recovery"] === true ||
            Date.now() - current.session.createdAt.getTime() >= 10 * 60 * 1000)
        )
          throw new APIError("FORBIDDEN", {
            message: "Confirm your email before linking this account",
          });

        const identityOrganizationId = z
          .string()
          .nullable()
          .parse(current?.session["identityOrganizationId"] ?? null);

        if (current && identityOrganizationId !== null) {
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
          ) {
            // Only a sign-in that reaches every membership manages the global account.
            const limit = signInLimit
              ? await signInLimit({
                  userId: current.user.id,
                  identityOrganizationId,
                  recovery: current.session["recovery"] === true,
                })
              : identityOrganizationId;

            if (limit !== null)
              throw new APIError("FORBIDDEN", {
                message: "Sign in with your Widefleet email to manage your global account",
              });

            // The organization owns addresses on its domains, so this sign-in cannot move one away.
            if (context.path === "/change-email")
              throw new APIError("FORBIDDEN", {
                message: "Your organization manages this email address",
              });
          }
        }

        if (
          context.path === "/email-otp/send-verification-otp" ||
          context.path === "/sign-in/email-otp"
        ) {
          if (!sendSignInEmail || !allowEmail)
            throw new APIError("FORBIDDEN", { message: "Email sign-in is not configured" });

          const input = z
            .object({
              email: z.email().max(254),
              type: z.literal("sign-in").optional(),
              name: z.string().trim().min(1).max(100).optional(),
            })
            .parse(context.body);

          const company = await domainSsoProvider?.(input.email.toLowerCase());

          if (company) throw companySsoRequired(company.providerId);

          if (!(await allowEmail(input.email.toLowerCase()))) {
            if (context.path === "/email-otp/send-verification-otp")
              return context.json({ success: true });

            const plugin = context.context.getPlugin("email-otp");

            if (!plugin) throw new Error("Email OTP plugin is not configured");
            throw APIError.from("BAD_REQUEST", plugin.$ERROR_CODES.INVALID_OTP);
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
      // Better Auth encrypts provider access and refresh tokens with the
      // authentication secret. Tokens saved before stay readable and are
      // replaced at the next sign-in.
      encryptOAuthTokens: true,
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
        activeOrganizationId: { type: "string", required: false, input: false },
        identityOrganizationId: { type: "string", required: false, input: false },
        recovery: { type: "boolean", defaultValue: false, input: false },
        companyConfiguration: { type: "string", defaultValue: "", input: false },
      },
    },
    advanced: {
      // Leave Better Auth's default when validation stays on: an explicit `true` turns its
      // note about adapters it cannot validate into a warning.
      database:
        validateSchema === false
          ? { generateId: () => crypto.randomUUID(), validateSchema }
          : { generateId: () => crypto.randomUUID() },
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
      personalSocialAccounts,
      ...(savePicture ? [signInPicture(savePicture)] : []),
      lastLoginMethod({
        cookieName: "platform.last_used_login_method",
        beforeStoreCookie: (context) => Boolean(context.context.newSession),
        customResolveMethod: (context) => {
          if (context.path.startsWith("/sso/callback/")) return "sso";

          if (
            context.path.startsWith("/callback/") &&
            context.params?.["id"] === "widefleet-google"
          )
            return "google";

          if (
            context.path.startsWith("/callback/") &&
            context.params?.["id"] === "widefleet-microsoft"
          )
            return "microsoft";

          return null;
        },
      }),
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
        membershipLimit: organizationMemberLimit,
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
      // The OAuth provider signs its tokens with these keys. Nothing reads the session JWT
      // header, and signing it would read the keys on every session lookup.
      jwt({
        jwt: { issuer: `${configuration.PLATFORM_URL}/api/auth` },
        disableSettingJwtHeader: true,
      }),
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
          picture: scopes.includes("profile") ? picture(user.image) : undefined,
        }),
        // `user.image` names the picture on this installation. OIDC clients need its URL.
        customUserInfoClaims: ({ user, scopes }) => ({
          picture: scopes.includes("profile") ? picture(user.image) : undefined,
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
