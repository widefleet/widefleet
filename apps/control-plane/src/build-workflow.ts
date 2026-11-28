import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { CloudflareWorkersModule } from "@cloudflare/workers-types";
import { z } from "zod";
import { bindingAppCi, executeBuild, failBuild } from "./lib/server/builds.ts";
import type { CloudflareBindings } from "./lib/server/cloudflare-config.ts";
import { readCloudflareConfiguration } from "./lib/server/cloudflare-config.ts";
import { withCloudflareDatabase } from "./lib/server/cloudflare-database.ts";
import type { Database } from "./lib/server/database.ts";
import type { createRuntimeExtension } from "./lib/server/runtime-extension.ts";
import { configuredSecretEncryption } from "./lib/server/secret-encryption.ts";

export const buildWorkflowCommand = z.strictObject({ id: z.uuid() });

const options = {
  retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
  timeout: "45 minutes",
} as const;

// The installation's runtime extension provides the Git repositories, so the
// Worker entry creates the class with it.
export const createBuildWorkflow = (createExtension: typeof createRuntimeExtension) =>
  class BuildWorkflow extends WorkflowEntrypoint<
    CloudflareBindings,
    z.infer<typeof buildWorkflowCommand>
  > {
    override async run(
      event: CloudflareWorkersModule.WorkflowEvent<z.infer<typeof buildWorkflowCommand>>,
      step: CloudflareWorkersModule.WorkflowStep,
    ) {
      const { id } = buildWorkflowCommand.parse(event.payload);
      const bindings = this.env;

      const withDatabase = <T>(operation: (database: Database) => Promise<T>) =>
        withCloudflareDatabase(bindings, ({ db }) => operation(db));

      // Every failure, including that of the setup, finishes the recorded build.
      try {
        const ci = bindings.APP_CI;

        if (!ci) throw new NonRetryableError("The app CI is not configured");
        const configuration = readCloudflareConfiguration(bindings);
        const encryption = configuredSecretEncryption(configuration);

        // The source backend uses its binding only; the database belongs to this phase.
        const source = await withDatabase(
          async (database) =>
            createExtension({
              database,
              configuration,
              binding: (name, schema) => schema.parse(bindings[name]),
            }).source,
        );

        if (!source)
          throw new NonRetryableError("This installation does not provide Git repositories");

        await step.do("build", options, () =>
          executeBuild(id, {
            withDatabase,
            source,
            ci: bindingAppCi(ci),
            platformUrl: configuration.PLATFORM_URL,
            encryption,
          }),
        );
      } catch (error) {
        await step.do("record-failure", options, () =>
          withDatabase((database) => failBuild(database, id, "The build could not finish")),
        );
        throw error;
      }
    }
  };
