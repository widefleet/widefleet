import { z } from "zod";

export const oauthProvider = z.enum(["google", "github", "microsoft"]);

export const oauthProfile = z.enum(["gmail-readonly", "github-repo", "onedrive-read"]);

const credentials = z.strictObject({
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(2048),
});

export const managedOAuthConfiguration = z.strictObject({
  origin: z.url().refine((value) => {
    const url = new URL(value);

    return url.protocol === "https:" && url.origin === value;
  }, "Managed OAuth requires a canonical HTTPS origin"),
  providers: z.strictObject({
    google: credentials.optional(),
    github: credentials.optional(),
    microsoft: credentials.optional(),
  }),
});

export const oauthRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("configuration"), profile: oauthProfile }),
  z.strictObject({
    action: z.literal("authorize"),
    profile: oauthProfile,
    state: z.string().min(1).max(256),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  z.strictObject({
    action: z.literal("exchange"),
    profile: oauthProfile,
    ticket: z.string().min(1).max(12000),
    code: z.string().min(1).max(4096),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  }),
  z.strictObject({
    action: z.literal("refresh"),
    profile: oauthProfile,
    refreshToken: z.string().min(1).max(12000),
  }),
]);

export type OAuthRequest = z.infer<typeof oauthRequest>;
