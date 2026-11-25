// One-click template installs: the builder builds a template's sources at the
// current commit, and the result is published through the same upload path as
// `widefleet deploy`, under the caller's authorization. An install never
// replaces a deployed app: it creates the app, or continues an earlier install
// whose app never received a deployment. The values of the secrets the
// template requires are saved with that first deployment.
import * as contract from "@platform/contracts";
import { decodeBase64 } from "@platform/contracts/builds";
import { Result } from "better-result";
import { z } from "zod";
import type { AppBuilder } from "./app-builder.ts";
import { templateDescription, templateSources } from "./app-templates.ts";
import { addGeneratedAssets, declaredSecrets, templateProject } from "./template-project.ts";
import type { createAppSecrets } from "./app-secrets.ts";
import type { createAppService } from "./apps.ts";
import type { Configuration } from "./config.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import type { createNetworkService } from "./network.ts";
import { appAlreadyDeployed, type createUploadService } from "./uploads.ts";

const encoder = new TextEncoder();

const decoder = new TextDecoder();

export const templateNetworkChanged =
  "The template's network access changed. Review it and install again.";

export const createTemplateInstalls = (
  configuration: Pick<Configuration, "GITHUB_TOKEN">,
  apps: Pick<
    ReturnType<typeof createAppService>,
    "named" | "create" | "resolve" | "recordTemplateInstall"
  >,
  uploads: Pick<ReturnType<typeof createUploadService>, "start" | "putAsset" | "publish">,
  network: Pick<ReturnType<typeof createNetworkService>, "change" | "read">,
  secrets: Pick<ReturnType<typeof createAppSecrets>, "encrypt">,
  builder?: AppBuilder,
) => ({
  available: Boolean(builder),
  /**
   * Installs a template. The template's page lists the declared origins next
   * to its install button, and that click grants exactly those
   * (`consentedNetwork`). A caller allowed to manage network permissions grants
   * whatever the template declares (`"declared"`). Other installs leave them
   * requested for the app's owner or an administrator.
   */
  install: (
    principal: Principal,
    input: z.infer<typeof contract.templateInstallInput>,
    options: { consentedNetwork?: z.infer<typeof contract.networkPolicy> | "declared" },
  ) =>
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

      const { commit, files } = yield* Result.await(
        templateSources(configuration, input.templateId),
      );

      // Read before any write: failing once the deployment was accepted would leave
      // a deployed app that the install can neither finish nor repeat.
      const description = Result.try(() => templateDescription(files));

      if (description.isErr())
        return yield* new InvalidOperation({
          code: "BAD_REQUEST",
          message: "The template's template.md has no readable description",
        });

      const wrangler = files["wrangler.jsonc"] ?? files["wrangler.json"];
      const required = declaredSecrets(wrangler && decoder.decode(wrangler));

      const unset = required.filter((secret) => !Object.hasOwn(input.secrets, secret));
      const unrequired = Object.keys(input.secrets).filter((secret) => !required.includes(secret));

      if (unset.length > 0)
        return yield* new InvalidOperation({
          code: "BAD_REQUEST",
          message: `Provide values for the template's required secrets: ${unset.join(", ")}`,
        });

      if (unrequired.length > 0)
        return yield* new InvalidOperation({
          code: "BAD_REQUEST",
          message: `The template does not require ${unrequired.join(", ")}. Set other secrets after installing.`,
        });

      // The builder bundles the code; static assets are uploaded as the CLI does.
      const { sources, assets } = yield* templateProject(files);
      const built = yield* Result.await(builder.bundle(sources));

      const declared = contract.networkPolicy.parse({
        backend: built.metadata.network?.backend ?? [],
        browser: built.metadata.network?.browser ?? [],
      });

      // The template can change after its page was shown; never grant more
      // than the person saw.
      const consented =
        options.consentedNetwork === "declared" ? declared : options.consentedNetwork;

      if (
        consented &&
        (["backend", "browser"] as const).some((target) =>
          declared[target].some((origin) => !consented[target].includes(origin)),
        )
      )
        return yield* new InvalidOperation({
          code: "CONFLICT",
          message: templateNetworkChanged,
        });

      // The upload validates the same metadata. Checking it before the app
      // exists keeps a template the platform rejects from leaving an app behind.
      const checked = contract.workerMetadata.safeParse({
        ...built.metadata,
        assets: { upload_session: crypto.randomUUID(), binding: assets.binding },
      });

      if (!checked.success)
        return yield* new InvalidOperation({
          code: "BAD_REQUEST",
          message: `The template's build is not deployable: ${z.prettifyError(checked.error)}`,
        });

      const documented = yield* Result.await(
        builder.document({
          files: sources,
          worker: built.worker,
          map: built.map,
          entry: built.entry,
          entrypoints: built.metadata.entrypoints,
        }),
      );

      // Home screens need PNG icons; a template that ships only its SVG icon gets
      // them rendered, as the CLI does for its deployments. They are optional:
      // an SVG the builder cannot render leaves the template's assets as they are.
      const icon = assets.manifest[contract.appIconSource.path];
      const svg = icon && assets.bytes.get(icon.hash);

      if (
        svg &&
        svg.byteLength <= contract.appIconSource.maxBytes &&
        contract.wantsGeneratedIcons((path) => Object.hasOwn(assets.manifest, path))
      ) {
        const rendered = await builder.icons(svg);

        if (rendered.isOk())
          addGeneratedAssets(
            assets,
            rendered.value.icons.map(({ path, png }) => ({ path, bytes: decodeBase64(png) })),
          );
      }

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

      const session = yield* Result.await(uploads.start(principal, installed.id, assets.manifest));

      const missing = new Set(session.missing);

      for (const [hash, bytes] of assets.bytes)
        if (missing.has(hash))
          yield* Result.await(uploads.putAsset(principal, installed.id, session.id, hash, bytes));

      const mapName = built.metadata.debug?.source_maps["worker.js"];

      const metadata = {
        ...checked.data,
        assets: { ...checked.data.assets, upload_session: session.id },
      };

      const modules = [
        { name: "worker.js", type: "esm" as const, bytes: encoder.encode(built.worker) },
        ...(mapName
          ? [{ name: mapName, type: "sourcemap" as const, bytes: encoder.encode(built.map) }]
          : []),
      ];

      // Publishing checks again, under the app's lock, that the app was not
      // deployed while the template was building. The template's secrets are
      // saved in the same step, so they never reach another deployment.
      const published = await uploads.publish(
        principal,
        installed.id,
        metadata,
        documented.documentation,
        modules,
        crypto.randomUUID(),
        {
          firstDeployment: true,
          ...(required.length > 0 && { secrets: await secrets.encrypt(input.secrets) }),
        },
      );

      if (
        published.isErr() &&
        published.error instanceof InvalidOperation &&
        published.error.message === appAlreadyDeployed
      )
        return yield* nameTaken();

      const deployment = yield* published;

      const notes: string[] = [];

      // Recorded once the deployment was accepted, so a rejected install
      // keeps offering Install in the catalog and leaves the app's description.
      const recorded = await apps.recordTemplateInstall(installed.id, deployment.id, {
        id: input.templateId,
        commit,
        description: description.value,
      });

      if (recorded.isErr())
        notes.push("The catalog could not record this install and still offers the template.");

      // Granted only once this install owns the app's first deployment, so a
      // rejected install leaves permissions unchanged. The app is installed by
      // then: a grant that fails stays requested for the owner to allow.
      if (consented)
        for (const target of ["backend", "browser"] as const)
          if (declared[target].length > 0) {
            const granted = await network.change(principal, installed.id, {
              target,
              action: "allow",
              origins: declared[target],
            });

            if (granted.isErr())
              notes.push(`Network access could not be allowed yet: ${granted.error.message}`);
          }

      const { requested } = yield* Result.await(network.read(principal, installed.id));

      return Result.ok(
        contract.templateInstall.parse({
          app: { ...installed, ...(recorded.isOk() ? recorded.value : undefined) },
          deployment,
          warnings: [...built.warnings, ...documented.warnings, ...notes],
          requestedNetwork:
            requested && (requested.backend.length > 0 || requested.browser.length > 0)
              ? requested
              : undefined,
        }),
      );
    }),
});
