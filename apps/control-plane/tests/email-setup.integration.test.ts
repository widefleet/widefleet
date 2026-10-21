import { expect, it, vi } from "vitest";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { installationSettings } from "@platform/contracts";
import { eq } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as extension from "../src/lib/server/runtime-extension.ts";
import { initializeRuntime } from "../src/lib/server/runtime-initialization.ts";
import { installation, organizationSettings } from "../src/lib/server/schema.ts";
import { readAppLogin, appLoginClientId } from "../src/lib/server/app-login-client.ts";
import { createTestEnvironment } from "./environment.ts";

it("publishes default app sign-in for an email-enabled owner-only bootstrap", async () => {
  const environment = await createTestEnvironment();

  const runtimeExtension = vi.spyOn(extension, "createRuntimeExtension").mockReturnValue({
    sendEmail: async () => {
      throw new Error("Setup must not send mail");
    },
  });

  try {
    await environment.database.db.delete(ssoProvider);
    await environment.database.db
      .update(installation)
      .set({ ownerId: null })
      .where(eq(installation.id, "widefleet"));
    await environment.database.db
      .update(organizationSettings)
      .set({ settings: installationSettings.parse({}), appClientSecret: null })
      .where(eq(organizationSettings.organizationId, "widefleet"));

    const bootstrap = join(
      environment.configuration.PLATFORM_STATE_DIRECTORY,
      "email-bootstrap.json",
    );

    await writeFile(
      bootstrap,
      JSON.stringify({
        owner: {
          name: "Bootstrap Owner",
          email: "bootstrap-owner@example.test",
          password: "synthetic-bootstrap-password",
        },
      }),
    );

    const runtime = await initializeRuntime(
      { ...environment.configuration, PLATFORM_BOOTSTRAP_FILE: bootstrap },
      fileURLToPath(new URL("../migrations", import.meta.url)),
    );

    try {
      const view = await runtime.settings.inspect();
      expect(view.sso).toBeNull();
      expect(view.activation.state).toBe("active");
      expect(view.error).toBeNull();
      expect(environment.authControl.read().configuration?.clientId).toBe(
        appLoginClientId("widefleet"),
      );
      expect(
        await readAppLogin(
          runtime.database.db,
          runtime.configuration,
          runtime.encryptionKey,
          "widefleet",
        ),
      ).toMatchObject({ management: { clientId: appLoginClientId("widefleet") } });
    } finally {
      await runtime.database.close();
    }
  } finally {
    runtimeExtension.mockRestore();
    await environment.close();
  }
});
