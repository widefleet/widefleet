import { google, microsoft } from "better-auth/social-providers";
import { verifyProviderIdToken } from "better-auth/oauth2";
import { z } from "zod";
import { companyTokens, CompanySignInRequired } from "./company-oauth.ts";
import type { mcpLoginConfiguration } from "./mcp-login.ts";

export const socialIdentity = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("google"), tenant: z.hostname(), subject: z.string().min(1) }),
  z.object({ provider: z.literal("microsoft"), tenant: z.uuid(), subject: z.uuid() }),
]);

export const socialOAuth = (
  configuration: z.infer<typeof mcpLoginConfiguration>,
  name: "google" | "microsoft",
) => {
  const registration = configuration[name];

  if (!registration) throw new Error("Sign-in provider is unavailable");

  const provider =
    name === "google"
      ? google({
          ...registration,
          hd: "*",
          accessType: "offline",
          prompt: "select_account consent",
        })
      : microsoft({
          ...registration,
          tenantId: "organizations",
          disableProfilePhoto: true,
          prompt: "select_account",
        });

  const redirectURI = `${configuration.origin}/oauth/callback/${name}`;

  return {
    authorize: async (state: string, verifier: string, nonce: string) => {
      const url = await provider.createAuthorizationURL({
        state,
        codeVerifier: verifier,
        redirectURI,
      });

      url.searchParams.set("nonce", nonce);

      return url;
    },
    exchange: async (code: string, verifier: string, nonce: string) => {
      const tokens = companyTokens.parse(
        await provider.validateAuthorizationCode({ code, codeVerifier: verifier, redirectURI }),
      );

      // Built-in social providers expose a decoder separately from their ID-token
      // verifier. Verification must happen before using claims to discover tenants.
      if (!(await verifyProviderIdToken(provider, tokens.idToken, nonce)))
        throw new CompanySignInRequired("Company identity could not be verified");
      const profile = await provider.getUserInfo(tokens);

      if (!profile) throw new CompanySignInRequired("Company identity could not be verified");

      const claims = z
        .object({
          sub: z.string(),
          hd: z.string().optional(),
          tid: z.string().optional(),
          oid: z.string().optional(),
        })
        .parse(profile.data);

      const identity = socialIdentity.parse(
        name === "google"
          ? { provider: name, tenant: claims.hd, subject: claims.sub }
          : { provider: name, tenant: claims.tid, subject: claims.oid },
      );

      return { tokens, identity };
    },
  };
};
