import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { decryptOAuthToken } from "better-auth/oauth2";
import { decodeJwt } from "jose";
import { z } from "zod";
import {
  fetchGraphPicture,
  fetchPictureUrl,
  pictureUrl,
  type PictureResult,
} from "./profile-picture.ts";

const pictureClaim = (idToken: string | null | undefined) => {
  if (!idToken) return null;

  try {
    return decodeJwt(idToken)["picture"] ?? null;
  } catch {
    return null;
  }
};

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
                : await context.context.adapter.findOne<{ appIdentityType: string }>({
                    model: "ssoProvider",
                    where: [{ field: "providerId", value: providerId }],
                  });

            const microsoft =
              providerId === "widefleet-microsoft" || company?.appIdentityType === "entra";

            const accessToken = account.accessToken
              ? await decryptOAuthToken(account.accessToken, context.context)
              : null;

            // Better Auth's sign-up copy is the fallback for providers that name the
            // picture only in their user info.
            const pictureSource = pictureUrl.safeParse(
              pictureClaim(account.idToken) ?? signedIn.user.image,
            );

            const picture = microsoft
              ? accessToken
                ? await fetchGraphPicture(accessToken)
                : null
              : pictureSource.success
                ? await fetchPictureUrl(pictureSource.data)
                : null;

            await save(signedIn.user.id, picture);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
