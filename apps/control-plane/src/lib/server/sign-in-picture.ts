import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { decryptOAuthToken } from "better-auth/oauth2";
import {
  fetchGraphPicture,
  fetchPictureUrl,
  pictureUrl,
  type PictureResult,
} from "@platform/auth-proxy/picture";
import { decodeJwt } from "jose";
import { z } from "zod";
import { oidcConfiguration, prepareCompanyOidc } from "./sso-origins.ts";

// The claims that name a picture; `null` when they cannot be read.
const pictureClaims = z.looseObject({ picture: z.unknown().optional() });

const idTokenClaims = (idToken: string | null | undefined) => {
  if (!idToken) return null;

  try {
    return pictureClaims.parse(decodeJwt(idToken));
  } catch {
    return null;
  }
};

// Some company providers name the picture only in their user info. Its endpoint comes from
// the connection, discovered and checked as for sign-in itself.
const userInfoPicture = async (issuer: string, configuration: string, accessToken: string) => {
  try {
    const endpoint = (
      await prepareCompanyOidc(issuer, oidcConfiguration.parse(JSON.parse(configuration)))
    ).configuration.userInfoEndpoint;

    if (!endpoint) return null;

    const response = await fetch(endpoint, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      await response.body?.cancel();

      return null;
    }

    return pictureClaims.parse(await response.json());
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

            const fromIdToken = idTokenClaims(account.idToken);

            const claims =
              fromIdToken?.picture === undefined && company?.oidcConfig && accessToken
                ? await userInfoPicture(company.issuer, company.oidcConfig, accessToken)
                : fromIdToken;

            // A provider that names no picture has none, for example after the person removed it.
            if (claims && (claims.picture === undefined || claims.picture === null)) {
              await save(signedIn.user.id, "none");

              return;
            }

            const url = pictureUrl.safeParse(claims?.picture);

            await save(
              signedIn.user.id,
              url.success
                ? await fetchPictureUrl(
                    new URL(url.data),
                    new URL(company?.issuer ?? "https://accounts.google.com").origin,
                    accessToken,
                  )
                : null,
            );
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
