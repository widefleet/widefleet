import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { decryptOAuthToken } from "better-auth/oauth2";
import { profileImage } from "@platform/contracts";
import { decodeJwt } from "jose";
import { z } from "zod";

// A missing or unusable picture parses as none.
export const usablePicture = profileImage.nullable().catch(null);

export const pictureClaim = (idToken: string | null | undefined) => {
  if (!idToken) return null;

  try {
    return usablePicture.parse(decodeJwt(idToken)["picture"]);
  } catch {
    return null;
  }
};

const googleUserInfo = "https://openidconnect.googleapis.com/v1/userinfo";

// Google leaves the picture out of Workspace users' ID tokens, but its user-info
// endpoint returns one.
const userInfoPicture = async (accessToken: string) => {
  try {
    const response = await fetch(googleUserInfo, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) return null;

    const profile = z.object({ picture: usablePicture }).safeParse(await response.json());

    return profile.success ? profile.data.picture : null;
  } catch {
    return null;
  }
};

// Better Auth copies the provider's picture only when it creates the user. Its option to
// refresh the profile on each sign-in also overwrites the name and email, so the picture
// is refreshed on its own. A provider without a picture keeps the current one.
// Company SSO refreshes it when it provisions the user.
export const signInPicture = {
  id: "sign-in-picture",
  hooks: {
    after: [
      {
        matcher: (context) => Boolean(context.path?.startsWith("/callback/")),
        handler: createAuthMiddleware(async (context) => {
          const signedIn = context.context.newSession;

          const providerId = z.string().optional().parse(context.params?.["id"]);

          if (!signedIn || !providerId) return;

          // Sign-in stores the provider's fresh tokens on the account it used.
          const account = (
            await context.context.internalAdapter.findAccounts(signedIn.user.id)
          ).find((candidate) => candidate.providerId === providerId);

          const picture =
            pictureClaim(account?.idToken) ??
            (providerId === "widefleet-google" && account?.accessToken
              ? await userInfoPicture(await decryptOAuthToken(account.accessToken, context.context))
              : null);

          if (picture && picture !== signedIn.user.image)
            await context.context.internalAdapter.updateUser(signedIn.user.id, { image: picture });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
