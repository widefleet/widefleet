import type { z } from "zod";
import { bootstrapConfiguration } from "@platform/contracts";
import type { Authentication } from "./auth.ts";
import type { createSettingsService } from "./settings.ts";
import { installationOrganizationId } from "../organization.ts";
import { eq } from "drizzle-orm";
import type { Database } from "./database.ts";
import { readInstallation, installationId } from "./installation-store.ts";
import { installation } from "./schema.ts";

export const initializeBootstrap = async (
  settings: ReturnType<typeof createSettingsService>,
  auth: Authentication,
  database: Database,
  input: z.infer<typeof bootstrapConfiguration>,
) => {
  const state = await readInstallation(database);

  if (state.ownerId && !state.bootstrapPending) return;

  if (!state.ownerId) await settings.createOwner(input.owner, true);

  if (input.settings) {
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
  } else {
    const result = await settings.publish();

    if (result.error) throw new Error(result.error);
  }

  await database
    .update(installation)
    .set({ bootstrapPending: false })
    .where(eq(installation.id, installationId));
};
