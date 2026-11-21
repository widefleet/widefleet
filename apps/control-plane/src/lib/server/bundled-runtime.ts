import { runtimeRelease } from "@platform/contracts";

// The Node distribution installs this release for an organization's first app job.
// Cloudflare installations serve every organization from the deployed installation
// runtime, so their Worker must not import this module.
export const loadBundledRuntime = async () =>
  runtimeRelease.parse(
    (await import("@platform/app-runtime/release", { with: { type: "json" } })).default,
  );
