import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { getSessionFromCtx } from "better-auth/api";
import { symmetricDecodeJWT, symmetricEncodeJWT, type SecretConfig } from "better-auth/crypto";
import { decodeJwt } from "jose";
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
      // Better Auth would store the photo as a data URL in the user row. The sign-in
      // copies it to Widefleet's picture store instead.
      disableProfilePhoto: true,
      disableDefaultScope: true,
      // `User.Read` lets the sign-in copy the user's photo from Microsoft Graph.
      scope: ["openid", "profile", "email", "User.Read"],
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

const companySsoHint = z.object({ providerId: z.string(), email: z.email() });

const companySsoHintSalt = "widefleet.company-sso-hint";

// The callback reports only an error code and description, so the description carries
// where to continue. Encryption keeps the address out of URLs that analytics or logs read.
export const readCompanySsoHint = async (secret: string | SecretConfig, token: string) =>
  companySsoHint
    .nullable()
    .catch(null)
    .parse(await symmetricDecodeJWT(token, secret, companySsoHintSalt));

export const validateSocialUser =
  (
    allowEmail: ((email: string) => Promise<boolean>) | undefined,
    allowUser: ((userId: string) => Promise<boolean>) | undefined,
    domainSsoProvider?: (email: string) => Promise<{ providerId: string } | null>,
  ): NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]> =>
  async ({ user, source }, context) => {
    const provider = source.oauth?.providerId;

    if (
      source.method !== "oauth" ||
      (provider !== "widefleet-google" && provider !== "widefleet-microsoft")
    )
      return undefined;
    const local = user.id ? await context.context.internalAdapter.findUserById(user.id) : null;
    let linkSession: "none" | "unqualified" | undefined;

    // The callback only reports the error code. Record which proof was missing,
    // without addresses, so rejected provider sign-ins can be diagnosed.
    const reject = (error: "sign_in_not_allowed" | "email_verification_required") => {
      const claims = z
        .looseObject({
          email_verified: z.union([
            z.boolean(),
            z.undefined().transform(() => "missing" as const),
            z.unknown().transform(() => "invalid" as const),
          ]),
          hd: z
            .string()
            .min(1)
            .transform(() => true)
            .catch(false),
        })
        .catch({ email_verified: "missing" as const, hd: false })
        .parse(source.oauth?.profile);

      context.context.logger.warn("Social sign-in rejected", {
        provider,
        action: source.action,
        error,
        localUser: !user.id
          ? "none"
          : !local
            ? "not_found"
            : local.emailVerified
              ? "verified"
              : "unverified",
        providerEmailVerified: user.emailVerified === true,
        emailVerifiedClaim: claims.email_verified,
        hostedDomainClaim: claims.hd,
        linkSession,
      });

      return { error };
    };

    if (local && allowUser && !(await allowUser(local.id))) return reject("sign_in_not_allowed");
    const email = source.action === "sign-in" ? local?.email : user.email;
    const company = email ? await domainSsoProvider?.(email.toLowerCase()) : null;

    // Addresses on a domain with required company SSO continue there instead.
    if (email && company)
      return {
        error: "company_sso_required",
        errorDescription: await symmetricEncodeJWT(
          companySsoHint.parse({ providerId: company.providerId, email: email.toLowerCase() }),
          context.context.secretConfig,
          companySsoHintSalt,
          600,
        ),
      };

    if (!email || !allowEmail || !(await allowEmail(email.toLowerCase())))
      return reject("sign_in_not_allowed");

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

      linkSession = session ? "unqualified" : "none";

      if (!local?.emailVerified) return reject("email_verification_required");
    }

    if (user.emailVerified !== true) return reject("email_verification_required");

    return undefined;
  };

// Microsoft also confirms the mail domains of personal accounts, which no organization owns.
const consumerTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";

const googleDomainProof = z.object({
  email: z.email(),
  email_verified: z.literal(true),
  hd: z.string().min(1),
});

const microsoftDomainProof = z.object({
  email: z.email(),
  tid: z.uuid(),
  // Microsoft emits this proof as a boolean or as the string "1".
  xms_edov: z.union([z.literal(true), z.literal("1")]),
});

// The company email domain that a provider account's saved ID token proves. Better Auth saves
// the token at every sign-in. Google names the Workspace domain; Microsoft confirms that the
// work tenant owns the address's domain.
export const providerEmailDomain = (providerId: string, idToken: string | null) => {
  if (!idToken) return null;
  let claims: unknown;

  try {
    claims = decodeJwt(idToken);
  } catch {
    return null;
  }

  if (providerId === "widefleet-google") {
    const proof = googleDomainProof.safeParse(claims);

    if (!proof.success) return null;
    const domain = proof.data.hd.toLowerCase();

    return proof.data.email.toLowerCase().split("@")[1] === domain ? domain : null;
  }

  if (providerId === "widefleet-microsoft") {
    const proof = microsoftDomainProof.safeParse(claims);

    return proof.success && proof.data.tid !== consumerTenant
      ? (proof.data.email.toLowerCase().split("@")[1] ?? null)
      : null;
  }

  return null;
};
