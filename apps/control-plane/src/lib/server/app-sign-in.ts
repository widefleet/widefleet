import type { Configuration } from "./config.ts";
import type { activationStatus, settingsPlan } from "@platform/contracts";
import type { companyIdentity } from "./company-identity.ts";
import type { z } from "zod";
import { installationOrganizationId } from "../organization.ts";

export interface AppSignIn {
  callbackUrl: string;
  publish(identity: z.infer<typeof companyIdentity>, clientSecret: string): Promise<string>;
  revision(identity: z.infer<typeof companyIdentity>, clientSecret: string): Promise<string>;
  status(expectedRevision: string): Promise<z.infer<typeof activationStatus>>;
  plan(identity: z.infer<typeof companyIdentity> | null): Promise<z.infer<typeof settingsPlan>>;
}

export const appCallbackUrl = (
  configuration: Configuration,
  organizationId = installationOrganizationId,
) =>
  `https://auth.${configuration.APP_DOMAIN}${configuration.APP_HTTPS_PORT === 443 ? "" : `:${configuration.APP_HTTPS_PORT}`}/oauth2/${organizationId}/callback`;
