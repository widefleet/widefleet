import { appCallbackUrl } from "./app-sign-in.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { activationStatus, identitySettingsInput } from "@platform/contracts";
import { authConfiguration } from "@platform/auth-proxy";
import type { Configuration } from "./config.ts";
import { readOptionalFile, writePrivateFile } from "./installation-files.ts";

export { appCallbackUrl } from "./app-sign-in.ts";

export const authBundle = z.strictObject({
  revision: z.string(),
  configuration: authConfiguration,
});

export const buildAuthBundle = (
  configuration: Configuration,
  identity: z.infer<typeof identitySettingsInput>,
  clientSecret: string,
  cookieSecret: string,
) => {
  const content = authConfiguration.parse({
    provider: identity.provider,
    clientId: identity.apps.clientId,
    clientSecret,
    cookieSecret,
    redirectUrl: appCallbackUrl(configuration),
    domain: configuration.APP_DOMAIN,
  });

  return {
    configuration: content,
    revision: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
};

export const publishAuthBundle = async (
  configuration: Configuration,
  bundle: z.infer<typeof authBundle>,
  force = false,
) => {
  const path = join(configuration.PLATFORM_AUTH_DIRECTORY, "desired.json");
  const content = JSON.stringify(bundle);

  if (force || (await readOptionalFile(path)) !== content) await writePrivateFile(path, content);
};

export const readActivation = async (configuration: Configuration) => {
  const source = await readOptionalFile(join(configuration.PLATFORM_AUTH_DIRECTORY, "status.json"));

  if (source === null)
    return activationStatus.parse({
      revision: "",
      state: "waiting",
      message: "The sign-in service is waiting for configuration",
    });

  return activationStatus.parse(JSON.parse(source));
};
