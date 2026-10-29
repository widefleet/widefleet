import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { getSessionFromCtx } from "better-auth/api";
import { z } from "zod";
import type { Configuration } from "./config.ts";

const credential = z
  .string()
  .optional()
  .transform((value) => value || undefined);

export const socialSignInConfiguration = z
  .object({
    GOOGLE_CLIENT_ID: credential,
    GOOGLE_CLIENT_SECRET: credential,
    MICROSOFT_CLIENT_ID: credential,
    MICROSOFT_CLIENT_SECRET: credential,
  })
  .superRefine((configuration, context) => {
    for (const provider of ["GOOGLE", "MICROSOFT"] as const) {
      if (
        Boolean(configuration[`${provider}_CLIENT_ID`]) !==
        Boolean(configuration[`${provider}_CLIENT_SECRET`])
      )
        context.addIssue({
          code: "custom",
          message: `${provider}_CLIENT_ID and ${provider}_CLIENT_SECRET must be configured together`,
        });
    }
  });

export const socialProviders = (configuration: Configuration) => {
  socialSignInConfiguration.parse(configuration);
  const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {};

  if (configuration.GOOGLE_CLIENT_ID && configuration.GOOGLE_CLIENT_SECRET)
    providers.google = {
      clientId: configuration.GOOGLE_CLIENT_ID,
      clientSecret: configuration.GOOGLE_CLIENT_SECRET,
      disableIdTokenSignIn: true,
      prompt: "select_account",
      mapProfileToUser: (profile) => {
        const identity = z
          .object({
            email: z.email(),
            email_verified: z.boolean(),
            hd: z.string().min(1).optional(),
          })
          .safeParse(profile);

        // Google is authoritative for Gmail and verified Workspace addresses.
        // A third-party address can retain email_verified after its owner changes.
        return {
          emailVerified:
            identity.success &&
            identity.data.email_verified &&
            (identity.data.email.toLowerCase().endsWith("@gmail.com") || Boolean(identity.data.hd)),
        };
      },
    };

  if (configuration.MICROSOFT_CLIENT_ID && configuration.MICROSOFT_CLIENT_SECRET)
    providers.microsoft = {
      clientId: configuration.MICROSOFT_CLIENT_ID,
      clientSecret: configuration.MICROSOFT_CLIENT_SECRET,
      tenantId: "common",
      disableIdTokenSignIn: true,
      disableProfilePhoto: true,
      disableDefaultScope: true,
      scope: ["openid", "profile", "email"],
      prompt: "select_account",
      mapProfileToUser: (profile) => {
        if (z.email().safeParse(profile.email).success) {
          // Microsoft also emits email-domain proof as the string "1". Preserve
          // an explicit email_verified decision and the provider's other checks.
          return profile.email_verified === undefined &&
            z.literal("1").safeParse(profile.xms_edov).success
            ? { emailVerified: true }
            : {};
        }

        // Some managed accounts omit email. A mail-shaped login name is only a
        // hint for the OTP flow, never evidence for automatic account linking.
        const username = z.email().safeParse(profile.preferred_username);

        return username.success ? { email: username.data, emailVerified: false } : {};
      },
    };

  return providers;
};

export const availableSocialProviders = (configuration: Configuration) =>
  (["google", "microsoft"] as const).filter((provider) =>
    Boolean(socialProviders(configuration)[provider]),
  );

// Legacy installation SSO uses "microsoft" in the account table. Separate provider
// IDs preserve that login boundary without rewriting existing SSO registrations.
export const personalSocialAccounts = {
  id: "personal-social-accounts",
  init: (context) => ({
    context: {
      socialProviders: context.socialProviders.map((provider) =>
        provider.id === "google" || provider.id === "microsoft"
          ? { ...provider, id: `widefleet-${provider.id}` }
          : provider,
      ),
    },
  }),
} satisfies BetterAuthPlugin;

export const validateSocialUser =
  (
    allowEmail: ((email: string) => Promise<boolean>) | undefined,
    allowUser: ((userId: string) => Promise<boolean>) | undefined,
  ): NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]> =>
  async ({ user, source }, context) => {
    const provider = source.oauth?.providerId;

    if (
      source.method !== "oauth" ||
      (provider !== "widefleet-google" && provider !== "widefleet-microsoft")
    )
      return undefined;
    const local = user.id ? await context.context.internalAdapter.findUserById(user.id) : null;

    if (local && allowUser && !(await allowUser(local.id))) return { error: "sign_in_not_allowed" };
    const email = source.action === "sign-in" ? local?.email : user.email;

    if (!email || !allowEmail || !(await allowEmail(email.toLowerCase())))
      return { error: "sign_in_not_allowed" };

    // Returning identities are bound to their provider ID, even if the provider's
    // email or proof has changed. Keep the local, verified address unchanged.
    if (source.action === "sign-in") return undefined;

    if (source.action === "link-account") {
      const session = await getSessionFromCtx(context);

      if (
        session &&
        session.user.id === user.id &&
        session.user.emailVerified &&
        session.user.email.toLowerCase() === email.toLowerCase() &&
        !session.session["identityOrganizationId"] &&
        !session.session["recovery"] &&
        Date.now() - session.session.createdAt.getTime() < 10 * 60 * 1000
      ) {
        // Explicit linking already carries the user ID in Better Auth's protected
        // OAuth state. Trust only this request after checking the current session;
        // never add these providers to the installation-wide trustedProviders list.
        context.context.trustedProviders = [...context.context.trustedProviders, provider];

        return undefined;
      }

      if (!local?.emailVerified) return { error: "email_verification_required" };
    }

    if (user.emailVerified !== true) return { error: "email_verification_required" };

    return undefined;
  };
