import { describe, expect, it } from "vitest";
import { installWithoutLockfile } from "./install.ts";

describe("install without pnpm-lock.yaml", () => {
  it.each([
    "{}",
    JSON.stringify({ name: "app", scripts: { build: "node build.mjs" } }),
    JSON.stringify({ dependencies: {}, devDependencies: null, optionalDependencies: {} }),
  ])("skips the install of a project without dependencies: %s", (manifest) => {
    expect(installWithoutLockfile(manifest)).toEqual({
      status: "skipped",
      reason: "package.json declares no dependencies",
    });
  });

  it.each(["dependencies", "devDependencies", "optionalDependencies"])(
    "fails a project whose %s need the missing lockfile",
    (field) => {
      expect(installWithoutLockfile(JSON.stringify({ [field]: { zod: "4.6.5" } }))).toEqual({
        status: "failed",
        message:
          "package.json declares dependencies, but pnpm-lock.yaml is missing. Run pnpm install and commit pnpm-lock.yaml",
      });
    },
  );

  it.each([
    ["{", "package.json is not valid JSON"],
    ["[]", "package.json must be a JSON object"],
    [JSON.stringify({ dependencies: ["zod"] }), "package.json must be a JSON object"],
  ])("fails an invalid package.json: %s", (manifest, message) => {
    const decision = installWithoutLockfile(manifest);

    if (decision.status !== "failed") throw new Error("Expected the build to fail");
    expect(decision.message).toContain(message);
  });
});
