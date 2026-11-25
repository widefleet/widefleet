import type { Observation } from "../src/lib/server/observation.ts";
import { getPlatformProxy } from "wrangler";
import { createCloudflareAppSignIn } from "../src/lib/server/app-sign-in-cloudflare.ts";
import type { CloudflareBindings } from "../src/lib/server/cloudflare-config.ts";
import type { Configuration } from "../src/lib/server/config.ts";
import type { Database } from "../src/lib/server/database.ts";
import { createCloudflareEmail } from "../src/lib/server/email-cloudflare.ts";
import { createInvitationService } from "../src/lib/server/members.ts";
import { createSettingsService } from "../src/lib/server/settings.ts";
import type { SecretEncryption } from "../src/lib/server/secret-encryption.ts";
import type { RuntimeExtension } from "../src/lib/server/runtime-extension.ts";

type SettingsPlatform = Pick<CloudflareBindings, "APP_RUNTIME" | "EMAIL" | "EMAIL_FROM">;

// Operator commands use the same bindings and services as the deployed application.
// The caller's bindings decide whether they are local or remote.
export const createCloudflareSettings = (
  configuration: Configuration,
  database: Database,
  encryption: SecretEncryption,
  cookieSecret: string,
  platform: SettingsPlatform,
  extension: RuntimeExtension,
  observation?: Observation,
) => {
  const sendEmail = extension.sendEmail ?? createCloudflareEmail(platform);

  return {
    settings: createSettingsService(
      configuration,
      database,
      encryption,
      (organizationId) =>
        createCloudflareAppSignIn(
          configuration,
          { ...platform, APP_COOKIE_SECRET: cookieSecret },
          organizationId,
        ),
      Boolean(sendEmail),
      observation,
    ),
    invitations: createInvitationService(
      database,
      configuration,
      sendEmail,
      extension.organizationAccess,
    ),
  };
};

// Standalone operator commands open their own session from a Wrangler configuration
// and close it when done.
export const connectCloudflareSettings = async (
  configuration: Configuration,
  database: Database,
  encryption: SecretEncryption,
  cookieSecret: string,
  configPath: string,
  extension: RuntimeExtension,
  observation?: Observation,
) => {
  const proxy = await getPlatformProxy<SettingsPlatform>({ configPath, persist: false });

  try {
    return {
      ...createCloudflareSettings(
        configuration,
        database,
        encryption,
        cookieSecret,
        proxy.env,
        extension,
        observation,
      ),
      close: () => proxy.dispose(),
    };
  } catch (cause) {
    await proxy.dispose();
    throw cause;
  }
};
