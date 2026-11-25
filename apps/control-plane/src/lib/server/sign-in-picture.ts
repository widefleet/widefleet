import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { decryptOAuthToken } from "better-auth/oauth2";
import {
  claimedPicture,
  fetchGraphPicture,
  fetchUserInfoClaims,
  googleUserInfo,
  pictureClaims,
  type PictureResult,
} from "@platform/auth-proxy/picture";
import { decodeJwt } from "jose";
import { z } from "zod";
import { oidcConfiguration, prepareCompanyOidc } from "./sso-origins.ts";

const idTokenClaims = (idToken: string | null | undefined) => {
  if (!idToken) return null;

  try {
    const claims = pictureClaims.safeParse(decodeJwt(idToken));

    return claims.success ? claims.data : null;
  } catch {
    return null;
  }
};

// A company connection's user info endpoint, discovered and checked as for sign-in itself;
// `null` when discovery fails, `undefined` when the provider has none.
const companyUserInfo = async (issuer: string, configuration: string) => {
  try {
    return (
      await prepareCompanyOidc(issuer, oidcConfiguration.parse(JSON.parse(configuration)), {
        discoverMissingUserInfo: true,
      })
    ).configuration.userInfoEndpoint;
  } catch {
    return null;
  }
};

const companyProvider = z.object({
  issuer: z.string(),
  appIdentityType: z.string(),
  oidcConfig: z.string().nullish(),
});

export type SavePicture = (userId: string, picture: PictureResult) => Promise<void>;

// Each sign-in through Google, Microsoft or company SSO copies the provider's current
// picture, so pages and apps never load it from the provider. Better Auth's own copy
// happens only at sign-up and stores the provider URL. A sign-in whose picture cannot
// be read keeps the current copy.
export const signInPicture = (save: SavePicture) =>
  ({
    id: "sign-in-picture",
    hooks: {
      after: [
        {
          matcher: (context) =>
            Boolean(
              context.path?.startsWith("/callback/") || context.path?.startsWith("/sso/callback/"),
            ),
          handler: createAuthMiddleware(async (context) => {
            const signedIn = context.context.newSession;

            const providerId = z
              .string()
              .optional()
              .parse(context.params?.["id"] ?? context.params?.["providerId"]);

            if (!signedIn || !providerId) return;

            // Sign-in stores the provider's fresh tokens on the account it used.
            const account = (
              await context.context.internalAdapter.findAccounts(signedIn.user.id)
            ).find((candidate) => candidate.providerId === providerId);

            if (!account) return;

            const company =
              providerId === "widefleet-google" || providerId === "widefleet-microsoft"
                ? null
                : companyProvider.parse(
                    await context.context.adapter.findOne({
                      model: "ssoProvider",
                      where: [{ field: "providerId", value: providerId }],
                    }),
                  );

            const accessToken = account.accessToken
              ? await decryptOAuthToken(account.accessToken, context.context)
              : undefined;

            if (providerId === "widefleet-microsoft" || company?.appIdentityType === "entra") {
              await save(
                signedIn.user.id,
                accessToken ? await fetchGraphPicture(accessToken) : null,
              );

              return;
            }

            // Providers that leave the picture out of the ID token name it in their user info:
            // Google for Workspace accounts, and some company providers.
            const fromIdToken = idTokenClaims(account.idToken);

            const userInfo =
              fromIdToken?.picture === undefined && accessToken
                ? providerId === "widefleet-google"
                  ? googleUserInfo
                  : company?.oidcConfig
                    ? await companyUserInfo(company.issuer, company.oidcConfig)
                    : undefined
                : undefined;

            // A failed lookup keeps the copy; only a provider without user info falls back to
            // the ID token, which then names no picture.
            const claims =
              userInfo === null
                ? null
                : userInfo && accessToken
                  ? await fetchUserInfoClaims(userInfo, accessToken)
                  : fromIdToken;

            await save(
              signedIn.user.id,
              await claimedPicture(
                claims,
                new URL(company?.issuer ?? "https://accounts.google.com").origin,
                accessToken,
              ),
            );
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
