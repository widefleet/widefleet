import { appCallbackUrl } from "./app-sign-in.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { activationStatus, identitySettingsInput } from "@platform/contracts";
import { appSsoConfiguration } from "../../../tools/edge-configuration.ts";
import type { Configuration } from "./config.ts";
import { readOptionalFile, writePrivateFile } from "./installation-files.ts";

export { appCallbackUrl } from "./app-sign-in.ts";

export const authBundle = z.strictObject({
  revision: z.string(),
  proxy: z.record(z.string(), z.unknown()),
  clientSecret: z.string().min(1),
  cookieSecret: z.string().min(1),
  redirectUrl: z.url(),
  domain: z.string().min(1),
});

export const buildAuthBundle = (
  configuration: Configuration,
  identity: z.infer<typeof identitySettingsInput>,
  clientSecret: string,
  cookieSecret: string,
) => {
  const content = {
    proxy: appSsoConfiguration(identity.provider, identity.apps.clientId, "/runtime/client-secret"),
    clientSecret,
    cookieSecret,
    redirectUrl: appCallbackUrl(configuration),
    domain: configuration.APP_DOMAIN,
  };

  return {
    ...content,
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

export const readActiveAuthBundle = async (configuration: Configuration) => {
  const source = await readOptionalFile(join(configuration.PLATFORM_AUTH_DIRECTORY, "active.json"));

  return source === null ? null : authBundle.parse(JSON.parse(source));
};
