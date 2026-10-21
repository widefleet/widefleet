import type {
  RuntimeExtension,
  RuntimeExtensionContext,
} from "../../src/lib/server/runtime-extension.ts";

export const createRuntimeExtension = ({
  configuration,
}: RuntimeExtensionContext): RuntimeExtension => {
  if (configuration.PLATFORM_URL !== "https://platform.example.test")
    throw new Error("The extension must receive the initialization configuration");

  return {
    sendEmail: async () => {
      throw new Error("Owner initialization must not send email");
    },
  };
};
