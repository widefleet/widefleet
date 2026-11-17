import { runtimeManagementRequest } from "./runtime-management-node.ts";
import { authControlPath } from "@platform/auth-proxy/publication";
import { createInstalledAppSignIn } from "./app-sign-in-installed.ts";
import type { Configuration } from "./config.ts";
import { installationOrganizationId } from "../organization.ts";

export const createAppSignIn = (
  configuration: Configuration,
  cookieSecret: string,
  organizationId = installationOrganizationId,
) =>
  createInstalledAppSignIn(
    configuration,
    cookieSecret,
    async (path, method, body) => {
      const response = await runtimeManagementRequest(
        configuration,
        `${authControlPath}${path}`,
        method,
        method === "PUT" ? body : undefined,
      );

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `The auth proxy could not apply its configuration (HTTP ${response.status})`,
        );
      }

      return response;
    },
    "immediate",
    organizationId,
  );
