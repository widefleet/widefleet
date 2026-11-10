import type { Provider } from "@platform/account-connection";
import { z } from "zod";

export const provider = {
  id: "microsoft",
  name: "OneDrive",
  description: "List, search and download files from your OneDrive.",
  setup:
    "Register a Microsoft application supporting the account types you use. Add delegated Files.Read permission and the web callback URL below. AUTH_SECRET must be a random secret of at least 32 characters.",
  clientId: "MICROSOFT_CLIENT_ID",
  clientSecret: "MICROSOFT_CLIENT_SECRET",
  subject: z.object({ oid: z.string().min(1) }).transform((profile) => profile.oid),
  socialProviders: (clientId, clientSecret) => ({
    microsoft: {
      clientId,
      clientSecret,
      tenantId: "common",
      scope: ["Files.Read"],
      disableSignUp: true,
      disableProfilePhoto: true,
      mapProfileToUser: (profile) => ({ providerEmail: profile.email }),
    },
  }),
} satisfies Provider;
