// Splits a template's files into the sources the app builder bundles and the
// static assets the control plane uploads, with the CLI's asset limits.
import { assetManifest, bindingName } from "@platform/contracts";
import { buildSourcePath } from "@platform/contracts/builds";
import { parseJsonc } from "@platform/contracts/jsonc";
import { Result } from "better-result";
import { z } from "zod";
import { hashAsset } from "./asset-hash.ts";
import { InvalidOperation } from "./errors.ts";

const maxAssetBytes = 25 * 1024 * 1024;

const maxAssetTotal = 250 * 1024 * 1024;

const maxAssets = 10_000;

const assetsConfiguration = z.looseObject({
  assets: z.strictObject({ directory: z.string().min(1), binding: bindingName }).optional(),
});

const invalid = (message: string) => new InvalidOperation({ code: "BAD_REQUEST", message });

const decoder = new TextDecoder();

export const templateProject = (files: Readonly<Record<string, Uint8Array>>) =>
  Result.gen(function* () {
    const wrangler = files["wrangler.jsonc"] ?? files["wrangler.json"];

    const configuration = wrangler
      ? assetsConfiguration.safeParse(
          Result.try(() => parseJsonc(decoder.decode(wrangler))).unwrapOr(null),
        )
      : null;

    // The builder reports an invalid Wrangler file with its own message.
    const assets = configuration?.success ? configuration.data.assets : undefined;

    const directory = assets?.directory.replace(/^\.\//, "").replace(/\/+$/, "");

    if (directory !== undefined && !buildSourcePath.safeParse(directory).success)
      return yield* invalid("The static asset directory must be inside the template");

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
