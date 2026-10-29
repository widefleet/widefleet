import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { z } from "zod";

export const providerId = "google";

export const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";

const profile = z.object({
  sub: z.string().min(1),
  name: z.string(),
  email: z.email(),
  email_verified: z.boolean(),
});

// Replace this configuration and the Gmail API methods when copying for another provider.
export const google = (clientId: string, clientSecret: string) =>
  ({
    providerId,
    clientId,
    clientSecret,
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      gmailScope,
    ],
    accessType: "offline",
    prompt: "select_account consent",
    pkce: true,
    disableSignUp: true,
    mapProfileToUser: (value) => ({ providerEmail: value.email }),
    getUserInfo: async (tokens) => {
      const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });

      if (!response.ok) throw new Error("Google profile request failed");
      const value = profile.parse(await response.json());

      return {
        id: value.sub,
        name: value.name,
        email: value.email,
        emailVerified: value.email_verified,
      };
    },
  }) satisfies GenericOAuthConfig;
