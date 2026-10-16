import * as contract from "@platform/contracts";
import { z } from "zod";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { InvalidOperation } from "./errors.ts";
import { verifyModules } from "./package-storage.ts";

export const validateCloudflareRuntime = (release: z.infer<typeof contract.runtimeRelease>) => {
  contract.runtimeRelease.parse(release);
  verifyModules(release);

  // Protocol 1 uses the installed loader, catalog and Workflow bindings. Releases
  // requiring different infrastructure need an explicit installation upgrade.
  if (release.cloudflare !== 1 || release.workflows !== 1)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "This release does not support Cloudflare runtime protocol 1",
    });
};

export const cloudflareRuntimeUpload = (release: z.infer<typeof contract.runtimeRelease>) => {
  validateCloudflareRuntime(release);
  const body = new FormData();
  body.set("metadata", JSON.stringify({ main_module: release.main }));

  for (const module of release.modules)
    body.set(
      module.name,
      new Blob([module.source], { type: "application/javascript+module" }),
      module.name,
    );

  return body;
};

export const readCloudflareRuntimeVersion = async (
  bindings: Pick<CloudflareBindings, "APP_RUNTIME">,
) => {
  if (!bindings.APP_RUNTIME) throw new Error("App runtime is not configured");

  const response = await bindings.APP_RUNTIME.fetch(
    "https://runtime.internal/.well-known/widefleet/runtime",
    {
      redirect: "manual",
    },
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Runtime version check failed (HTTP ${response.status})`);
  }

  return z.object({ runtimeVersion: contract.runtimeVersion }).parse(await response.json())
    .runtimeVersion;
};
