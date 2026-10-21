import { getPlatformProxy } from "wrangler";
import { createCloudflareAppSignIn } from "../src/lib/server/app-sign-in-cloudflare.ts";
import type { CloudflareBindings } from "../src/lib/server/cloudflare-config.ts";
import type { Configuration } from "../src/lib/server/config.ts";
import type { Database } from "../src/lib/server/database.ts";
import { createCloudflareEmail } from "../src/lib/server/email-cloudflare.ts";
import { createInvitationService } from "../src/lib/server/members.ts";
import { createSettingsService } from "../src/lib/server/settings.ts";
import type { RuntimeExtension } from "../src/lib/server/runtime-extension.ts";
import { loadRuntimeExtension } from "./runtime-extension.ts";

// Operator commands use the same bindings and services as the deployed application.
// The supplied Wrangler configuration decides whether bindings are local or remote.
export const connectCloudflareSettings = async (
  configuration: Configuration,
  database: Database,
  encryptionKey: string,
  cookieSecret: string,
  configPath: string,
  extension?: RuntimeExtension,
) => {
  const selected = extension ?? (await loadRuntimeExtension({ configuration, database }));

  const proxy = await getPlatformProxy<
    Pick<CloudflareBindings, "APP_RUNTIME" | "EMAIL" | "EMAIL_FROM">
  >({ configPath, persist: false });

  try {
    const sendEmail = selected.sendEmail ?? createCloudflareEmail(proxy.env);

    return {
      settings: createSettingsService(
        configuration,
        database,
        encryptionKey,
        (organizationId) =>
          createCloudflareAppSignIn(
            configuration,
            { ...proxy.env, APP_COOKIE_SECRET: cookieSecret },
            organizationId,
          ),
        Boolean(sendEmail),
      ),
      invitations: createInvitationService(
        database,
        configuration,
        sendEmail,
        selected.organizationAccess,
      ),
      close: () => proxy.dispose(),
    };
  } catch (cause) {
    await proxy.dispose();
    throw cause;
  }
};
