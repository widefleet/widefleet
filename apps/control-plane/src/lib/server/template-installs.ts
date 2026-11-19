// One-click template installs: the builder builds a template's sources at the
// current commit, and the result is published through the same upload path as
// `widefleet deploy`, under the caller's authorization.
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import type { z } from "zod";
import type { AppBuilder } from "./app-builder.ts";
import { templateSources } from "./app-templates.ts";
import type { createAppService } from "./apps.ts";
import type { Configuration } from "./config.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import type { createUploadService } from "./uploads.ts";

const encoder = new TextEncoder();

export const createTemplateInstalls = (
  configuration: Pick<Configuration, "GITHUB_TOKEN">,
  apps: Pick<ReturnType<typeof createAppService>, "resolve">,
  uploads: Pick<ReturnType<typeof createUploadService>, "start" | "publish">,
  builder?: AppBuilder,
) => ({
  available: Boolean(builder),
  install: (principal: Principal, input: z.infer<typeof contract.templateInstallInput>) =>
    Result.gen(async function* () {
      if (!builder)
        return yield* new InvalidOperation({
          code: "BAD_REQUEST",
          message: "This installation does not build templates; set one up with the Widefleet CLI",
        });

      const { files } = yield* Result.await(templateSources(configuration, input.templateId));
      // Resolving first applies app permissions before any build work.
      const app = yield* Result.await(apps.resolve(principal, input.name ?? input.templateId));
      const built = yield* Result.await(builder.bundle(files));

      const documented = yield* Result.await(
        builder.document({
          files,
          worker: built.worker,
          map: built.map,
          entry: built.entry,
          entrypoints: built.metadata.entrypoints,
        }),
      );

      const session = yield* Result.await(uploads.start(principal, app.id, {}));
      const mapName = built.metadata.debug?.source_maps["worker.js"];

      const metadata = contract.workerMetadata.parse({
        ...built.metadata,
        service_documentation: documented.documentation,
        assets: { upload_session: session.id, binding: "ASSETS" },
      });

      const modules = [
        { name: "worker.js", type: "esm" as const, bytes: encoder.encode(built.worker) },
        ...(mapName
          ? [{ name: mapName, type: "sourcemap" as const, bytes: encoder.encode(built.map) }]
          : []),
      ];

      const deployment = yield* Result.await(
        uploads.publish(principal, app.id, metadata, modules, crypto.randomUUID()),
      );

      return Result.ok(
        contract.templateInstall.parse({
          app,
          deployment,
          warnings: [...built.warnings, ...documented.warnings],
        }),
      );
    }),
});
