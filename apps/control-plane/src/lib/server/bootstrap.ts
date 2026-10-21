import type { z } from "zod";
import { bootstrapConfiguration } from "@platform/contracts";
import type { Authentication } from "./auth.ts";
import type { createSettingsService } from "./settings.ts";
import { installationOrganizationId } from "../organization.ts";

export const initializeBootstrap = async (
  settings: ReturnType<typeof createSettingsService>,
  auth: Authentication,
  input: z.infer<typeof bootstrapConfiguration>,
) => {
  await settings.createOwner(input.owner);

  if (!input.settings) return;
  // Registration follows the same native SSO authorization as interactive setup.
  const login = await auth.api.signInEmail({ body: input.owner, returnHeaders: true });

  const headers = new Headers({
    cookie: login.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; "),
  });

  try {
    const result = await settings.initialize(input.settings, installationOrganizationId, {
      auth,
      headers,
    });

    if (result.error) throw new Error(result.error);
  } finally {
    await auth.api.signOut({ headers });
  }
};
