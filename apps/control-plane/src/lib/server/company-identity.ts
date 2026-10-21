import { z } from "zod";

import { companyProvider } from "@platform/contracts";

export { companyProvider, identityUrl } from "@platform/contracts";

const credentials = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });

export const companyIdentity = z.object({
  provider: companyProvider,
  management: credentials,
  directory: credentials.nullable().default(null),
});

export { companyAccountProvider, providerIssuer } from "../company-identity.ts";
