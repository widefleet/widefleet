import type { Provider } from "@platform/account-connection";
import { z } from "zod";

export const provider = {
  id: "github",
  name: "GitHub",
  description: "List repositories and issues and read repository files using your GitHub account.",
  setup:
    "Register a GitHub App with read-only Contents and Issues permissions and read access to email addresses, or a GitHub OAuth app. Set the callback URL below. OAuth apps require the repo scope for private repositories, which also grants write access; this connector only exposes read methods. AUTH_SECRET must be a random secret of at least 32 characters.",
  clientId: "GITHUB_CLIENT_ID",
  clientSecret: "GITHUB_CLIENT_SECRET",
  subject: z.object({ id: z.number().int() }).transform((profile) => String(profile.id)),
  socialProviders: (clientId, clientSecret) => ({
    github: {
      clientId,
      clientSecret,
      scope: ["repo"],
      disableSignUp: true,
      mapProfileToUser: (profile) => ({ providerEmail: profile.email }),
    },
  }),
} satisfies Provider;
