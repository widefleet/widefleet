import type { Observation } from "../src/lib/server/observation.ts";
import { createCloudflareAppSignIn } from "../src/lib/server/app-sign-in-cloudflare.ts";
import type { CloudflareBindings } from "../src/lib/server/cloudflare-config.ts";
import type { Configuration } from "../src/lib/server/config.ts";
import type { Database } from "../src/lib/server/database.ts";
import { createCloudflareEmail } from "../src/lib/server/email-cloudflare.ts";
import { createInvitationService } from "../src/lib/server/members.ts";
import { createSettingsService } from "../src/lib/server/settings.ts";
import type { RuntimeExtension } from "../src/lib/server/runtime-extension.ts";

// Operator commands use the same bindings and services as the deployed application.
// The caller's Wrangler configuration decides whether bindings are local or remote.
export const connectCloudflareSettings = (
  configuration: Configuration,
  database: Database,
  encryptionKey: string,
  cookieSecret: string,
  platform: Pick<CloudflareBindings, "APP_RUNTIME" | "EMAIL" | "EMAIL_FROM">,
  extension: RuntimeExtension,
  observation?: Observation,
) => {
  const sendEmail = extension.sendEmail ?? createCloudflareEmail(platform);

  return {
    settings: createSettingsService(
      configuration,
      database,
      encryptionKey,
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
