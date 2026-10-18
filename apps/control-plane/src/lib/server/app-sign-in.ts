import type { Configuration } from "./config.ts";
import type { activationStatus, identitySettingsInput, settingsPlan } from "@platform/contracts";
import type { z } from "zod";

export interface AppSignIn {
  callbackUrl: string;
  publish(identity: z.infer<typeof identitySettingsInput>, clientSecret: string): Promise<string>;
  revision(identity: z.infer<typeof identitySettingsInput>, clientSecret: string): Promise<string>;
  status(expectedRevision: string): Promise<z.infer<typeof activationStatus>>;
  plan(
    identity: z.infer<typeof identitySettingsInput> | null,
  ): Promise<z.infer<typeof settingsPlan>>;
}

export const appCallbackUrl = (configuration: Configuration) =>
  `https://auth.${configuration.APP_DOMAIN}${configuration.APP_HTTPS_PORT === 443 ? "" : `:${configuration.APP_HTTPS_PORT}`}/oauth2/callback`;
