import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { profileImage } from "@platform/contracts";
import { decodeJwt } from "jose";
import { z } from "zod";

const pictureClaim = (idToken: string | null | undefined) => {
  if (!idToken) return null;

  try {
    const picture = profileImage.safeParse(decodeJwt(idToken)["picture"]);

    return picture.success ? picture.data : null;
  } catch {
    return null;
  }
};

// Better Auth copies the provider's picture only when it creates the user. Its option to
// refresh the profile on each sign-in also overwrites the name and email, so the picture
// is refreshed on its own. A provider without a picture claim keeps the current one.
export const signInPicture = {
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

          const picture = pictureClaim(account?.idToken);

          if (picture && picture !== signedIn.user.image)
            await context.context.internalAdapter.updateUser(signedIn.user.id, { image: picture });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
