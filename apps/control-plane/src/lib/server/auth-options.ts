import { oauthDeviceAuthorization, oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthOptions } from "better-auth";
import { genericOAuth, jwt, organization, oneTimeToken } from "better-auth/plugins";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { z } from "zod";
import type { Configuration } from "./config.ts";
import { companyAccountProvider, providerIssuer } from "./company-identity.ts";
import {
  installationOrganizationId,
  organizationAccess,
  organizationRole,
  organizationRoles,
} from "../organization.ts";

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

export const managementProviders = (configuration: Configuration): GenericOAuthConfig[] => {
  const identity = configuration.IDENTITY;

  if (!identity) return [];

  const provider = identity.provider;

  return [
    {
      providerId: companyAccountProvider(identity),
      name: provider.label,
      clientId: identity.management.clientId,
      clientSecret: identity.management.clientSecret,
      discoveryUrl: `${providerIssuer(provider)}/.well-known/openid-configuration`,
      requireIdTokenVerification: true,
      scopes: ["openid", "profile", "email"],
      accountSubject: ({ profile }) =>
        provider.type === "entra"
          ? z.object({ oid: z.uuid(), tid: z.literal(provider.tenantId) }).parse(profile).oid
          : z.object({ sub: z.string().min(1) }).parse(profile).sub,
    },
  ];
};

export const authenticationOptions = (configuration: Configuration) =>
  ({
    appName: "Widefleet",
    baseURL: configuration.PLATFORM_URL,
    secret: configuration.BETTER_AUTH_SECRET,
    trustedOrigins: [configuration.PLATFORM_URL],
    // This installation has one organization. Membership comes from verified
    // management sign-in; invitations, teams and organization lifecycle are not exposed.
    disabledPaths: [
      "/sign-up/email",
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
    ],
    emailAndPassword: {
      enabled: configuration.LOCAL_PASSWORD_ENABLED,
      disableSignUp: true,
      minPasswordLength: 12,
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path !== "/device/approve") return;
        const current = await getSessionFromCtx(context);

        if (current?.session["recovery"] === true)
          throw new APIError("FORBIDDEN", {
            message:
              "Sign in with your company account before authorizing a CLI. Recovery access cannot create long-lived credentials.",
          });
      }),
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: true,
        trustedProviders: configuration.IDENTITY
          ? [companyAccountProvider(configuration.IDENTITY)]
          : [],
      },
    },
    session: {
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 30,
      additionalFields: {
        recovery: { type: "boolean", defaultValue: false, input: false },
        companyConfiguration: { type: "string", defaultValue: "", input: false },
      },
    },
    advanced: {
      cookiePrefix: "platform",
      crossSubDomainCookies: { enabled: false },
      // Keep browser protection enabled in integration tests too; Better Auth's
      // test-environment defaults otherwise skip these checks.
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    plugins: [
      oneTimeToken({ expiresIn: 10, storeToken: "hashed", disableClientRequest: true }),
      organization({
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        ac: organizationAccess,
        roles: organizationRoles,
        organizationHooks: {
          beforeUpdateMemberRole: async ({ newRole, organization: target }) => {
            if (
              target.id !== installationOrganizationId ||
              !organizationRole.safeParse(newRole).success
            )
              throw new APIError("BAD_REQUEST", {
                message: "Choose Owner, Admin or Member in this installation",
              });
          },
        },
      }),
      genericOAuth({ config: managementProviders(configuration) }),
      jwt({ jwt: { issuer: `${configuration.PLATFORM_URL}/api/auth` } }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/device",
        scopes: cliScopes,
        resources: [
          { identifier: apiResource(configuration), allowedScopes: cliScopes, accessTokenTtl: 300 },
        ],
        resourceSeedMode: "overwrite",
        enforcePerClientResources: true,
        allowDynamicClientRegistration: false,
        clientPrivileges: () => false,
        resourcePrivileges: () => false,
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
      }),
      oauthDeviceAuthorization({ verificationUri: `${configuration.PLATFORM_URL}/device` }),
    ],
  }) satisfies BetterAuthOptions;
