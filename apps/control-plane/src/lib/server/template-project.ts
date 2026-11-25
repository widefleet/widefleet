// Splits a template's files into the sources the app builder bundles and the
// static assets the control plane uploads, with the CLI's asset limits.
import { assetManifest, bindingName, requiredSecrets } from "@platform/contracts";
import { buildSourcePath } from "@platform/contracts/builds";
import { parseJsonc } from "@platform/contracts/jsonc";
import { Result } from "better-result";
import { z } from "zod";
import { hashAsset } from "./asset-hash.ts";
import { InvalidOperation } from "./errors.ts";

const maxAssetBytes = 25 * 1024 * 1024;

const maxAssetTotal = 250 * 1024 * 1024;

const maxAssets = 10_000;

const wranglerConfiguration = z.looseObject({
  assets: z.unknown().optional(),
  secrets: z.unknown().optional(),
});

const secretsSettings = z.looseObject({ required: requiredSecrets.default([]) });

const assetsSettings = z.strictObject({ directory: z.string().min(1), binding: bindingName });

const invalid = (message: string) => new InvalidOperation({ code: "BAD_REQUEST", message });

const decoder = new TextDecoder();

/**
 * The static assets a Wrangler file declares, with the directory relative to
 * the project. The builder reports an unreadable Wrangler file with its own
 * message, but asset settings that the upload cannot use fail here.
 */
export const declaredAssets = (wrangler: string | undefined) => {
  const configuration = wranglerConfiguration.safeParse(
    wrangler === undefined ? null : Result.try(() => parseJsonc(wrangler)).unwrapOr(null),
  );

  if (!configuration.success || configuration.data.assets === undefined)
    return Result.ok(undefined);

  const assets = assetsSettings.safeParse(configuration.data.assets);

  if (!assets.success)
    return Result.err(
      invalid(
        "Static assets need a directory and a binding name of letters, digits and underscores",
      ),
    );

  const directory = assets.data.directory.replace(/^\.\//, "").replace(/\/+$/, "");

  if (!buildSourcePath.safeParse(directory).success)
    return Result.err(invalid("The static asset directory must be inside the template"));

  return Result.ok({ binding: assets.data.binding, directory });
};

/**
 * The secrets a Wrangler file requires. An unreadable list is left to the
 * builder, which reports it with its own message.
 */
export const declaredSecrets = (wrangler: string | undefined) => {
  const configuration = wranglerConfiguration.safeParse(
    wrangler === undefined ? null : Result.try(() => parseJsonc(wrangler)).unwrapOr(null),
  );

  if (!configuration.success || configuration.data.secrets === undefined) return [];

  return secretsSettings.safeParse(configuration.data.secrets).data?.required ?? [];
};

/**
 * Adds optional generated assets, such as rendered app icons, unless they would
 * take the project over the platform's asset limits.
 */
export const addGeneratedAssets = (
  assets: { manifest: z.infer<typeof assetManifest>; bytes: Map<string, Uint8Array> },
  files: { path: string; bytes: Uint8Array }[],
) => {
  const total = [...assets.bytes.values(), ...files.map(({ bytes }) => bytes)].reduce(
    (sum, bytes) => sum + bytes.byteLength,
    0,
  );

  if (Object.keys(assets.manifest).length + files.length > maxAssets || total > maxAssetTotal)
    return false;

  for (const { path, bytes } of files) {
    const hash = hashAsset(path, bytes);

    assets.bytes.set(hash, bytes);
    assets.manifest[path] = { hash, size: bytes.byteLength };
  }

  return true;
};

export const templateProject = (files: Readonly<Record<string, Uint8Array>>) =>
  Result.gen(function* () {
    const wrangler = files["wrangler.jsonc"] ?? files["wrangler.json"];
    const assets = yield* declaredAssets(wrangler && decoder.decode(wrangler));
    const directory = assets?.directory;
    const prefix = directory === undefined ? undefined : `${directory}/`;
    const sources: Record<string, string> = {};
    const manifest: z.infer<typeof assetManifest> = {};
    const bytes = new Map<string, Uint8Array>();
    let total = 0;

    for (const [path, content] of Object.entries(files)) {
      if (prefix === undefined || !path.startsWith(prefix)) {
        sources[path] = decoder.decode(content);
        continue;
      }

      const name = `/${path.slice(prefix.length)}`;

      if (name === "/.assetsignore")
        return yield* invalid("Custom static asset ignore rules are not supported");

      if (name.endsWith(".map"))
        return yield* invalid("Source maps in static assets are deployed with the Widefleet CLI");

      if (content.byteLength > maxAssetBytes)
        return yield* invalid(`Static asset exceeds 25 MiB: ${name}`);

      const hash = hashAsset(name, content);

      if (!bytes.has(hash)) total += content.byteLength;
      bytes.set(hash, content);
      manifest[name] = { hash, size: content.byteLength };

      if (Object.keys(manifest).length > maxAssets || total > maxAssetTotal)
        return yield* invalid("Static assets exceed the platform limit");
    }

    return Result.ok({
      sources,
      assets: { binding: assets?.binding ?? "ASSETS", manifest, bytes },
    });
  });
