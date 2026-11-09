import type { Provider } from "@platform/account-connection";
import { z } from "zod";

const scope = "https://www.googleapis.com/auth/gmail.readonly";

export const provider = {
  id: "google",
  name: "Gmail",
  description: "Search and read messages and download attachments from your Gmail account.",
  setup:
    "Create a Google OAuth web application, enable the Gmail API, and register the callback URL below. AUTH_SECRET must be a random secret of at least 32 characters.",
  clientId: "GOOGLE_CLIENT_ID",
  clientSecret: "GOOGLE_CLIENT_SECRET",
  subject: z.object({ sub: z.string().min(1) }).transform((profile) => profile.sub),
  permission: scope,
  socialProviders: (clientId, clientSecret) => ({
    google: {
      clientId,
      clientSecret,
      scope: [scope],
      accessType: "offline",
      prompt: "select_account consent",
      disableSignUp: true,
      mapProfileToUser: (profile) => ({ providerEmail: profile.email }),
    },
  }),
} satisfies Provider;
