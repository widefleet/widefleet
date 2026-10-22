import { expect, it, vi } from "vitest";
import { ssoProvider } from "../src/lib/server/auth-schema.ts";
import { installationSettings } from "@platform/contracts";
import { eq } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as extension from "../src/lib/server/runtime-extension.ts";
import { initializeRuntime } from "../src/lib/server/runtime-initialization.ts";
import { installation, organizationSettings } from "../src/lib/server/schema.ts";
import { readAppLogin, appLoginClientId } from "../src/lib/server/app-login-client.ts";
import { createTestEnvironment } from "./environment.ts";

it.each(["runtime", "source command"])(
  "publishes default app sign-in during %s bootstrap",
  async (mode) => {
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

      if (mode === "source command") {
        const extensionPath = join(
          environment.configuration.PLATFORM_STATE_DIRECTORY,
          "extension.mjs",
        );

        await writeFile(
          extensionPath,
          'export const createRuntimeExtension = () => ({ sendEmail: async () => { throw new Error("Setup must not send mail"); } });',
        );
        await promisify(execFile)(process.execPath, ["apps/control-plane/tools/initialize.ts"], {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: {
            ...process.env,
            ...environment.environment,
            PLATFORM_BOOTSTRAP_FILE: bootstrap,
            WIDEFLEET_RUNTIME_EXTENSION: extensionPath,
          },
          timeout: 20_000,
        });
      }

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
  },
  30_000,
);
