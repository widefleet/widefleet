// One-click template installs: the builder builds a template's sources at the
// current commit, and the result is published through the same upload path as
// `widefleet deploy`, under the caller's authorization. An install never
// replaces a deployed app: it creates the app, or continues an earlier install
// whose app never received a deployment.
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { z } from "zod";
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
  apps: Pick<ReturnType<typeof createAppService>, "named" | "create" | "resolve">,
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

      const appInput = contract.createAppInput.safeParse({
        slug: input.name ?? input.templateId,
        displayName: input.name ?? input.templateId,
      });

      if (!appInput.success)
        return yield* new InvalidOperation({
          code: "BAD_REQUEST",
          message: z.prettifyError(appInput.error),
        });

      const name = appInput.data.slug;

      const nameTaken = () =>
        new InvalidOperation({
          code: "CONFLICT",
          message: `An app named ${name} already exists. Install the template under another name.`,
        });

      // Permission and name checks come before any build work.
      if (!principal.creator)
        return yield* new InvalidOperation({
          code: "FORBIDDEN",
          message: "App creator permission is required",
        });

      const existing = yield* Result.await(apps.named(principal, name));

      if (existing?.deployed) return yield* nameTaken();

      const { files } = yield* Result.await(templateSources(configuration, input.templateId));
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

      // The app exists only once its build succeeded, so a failed build leaves
      // the name free. An app without deployments is an earlier install that
      // failed to publish, which this one completes.
      const created = await (existing
        ? apps.resolve(principal, name)
        : apps.create(principal, appInput.data));

      if (
        created.isErr() &&
        created.error instanceof InvalidOperation &&
        created.error.code === "CONFLICT"
      )
        return yield* nameTaken();

      const installed = yield* created;
      const session = yield* Result.await(uploads.start(principal, installed.id, {}));
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
        uploads.publish(principal, installed.id, metadata, modules, crypto.randomUUID()),
      );

      return Result.ok(
        contract.templateInstall.parse({
          app: installed,
          deployment,
          warnings: [...built.warnings, ...documented.warnings],
        }),
      );
    }),
});
