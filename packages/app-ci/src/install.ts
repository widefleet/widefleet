import { z } from "zod";

const dependencies = z.record(z.string(), z.unknown()).nullish();

const manifest = z.object({
  dependencies,
  devDependencies: dependencies,
  optionalDependencies: dependencies,
});

/**
 * Decides the install of a project that has package.json but no pnpm-lock.yaml.
 * A frozen install needs the lockfile, so only a project without dependencies
 * builds without one.
 */
export const installWithoutLockfile = (
  text: string,
): { status: "skipped"; reason: string } | { status: "failed"; message: string } => {
  let document: unknown;

  try {
    document = JSON.parse(text);
  } catch {
    return { status: "failed", message: "package.json is not valid JSON" };
  }

  const parsed = manifest.safeParse(document);

  if (!parsed.success)
    return {
      status: "failed",
      message:
        "package.json must be a JSON object whose dependency fields map package names to versions",
    };

  const declared = Object.values(parsed.data).some(
    (entries) => entries && Object.keys(entries).length > 0,
  );

  return declared
    ? {
        status: "failed",
        message:
          "package.json declares dependencies, but pnpm-lock.yaml is missing. Run pnpm install and commit pnpm-lock.yaml",
      }
    : { status: "skipped", reason: "package.json declares no dependencies" };
};
