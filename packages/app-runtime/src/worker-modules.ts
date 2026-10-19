import type { storedModule } from "@platform/contracts";
import type { z } from "zod";
import type { ParentEnvironment } from "./types.ts";

export const loadModules = async (
  environment: ParentEnvironment,
  scope: string,
  references: z.infer<typeof storedModule>[],
) => {
  const modules = new Map<string, string | WorkerLoaderModule>();

  for (const module of references) {
    if (module.type === "sourcemap") continue;
    const object = await environment.WIDEFLEET_PACKAGES.get(`${scope}/modules/${module.sha256}`);

    if (!object) throw new Error("Published module is missing");
    const data = await object.arrayBuffer();

    if (data.byteLength !== module.size) throw new Error("Published module checksum mismatch");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));

    if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== module.sha256)
      throw new Error("Published module checksum mismatch");

    switch (module.type) {
      case "esm":
        modules.set(
          module.name,
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data),
        );
        break;
      case "text":
        modules.set(module.name, {
          text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data),
        });
        break;
      case "wasm":
        modules.set(module.name, { wasm: data });
        break;
      case "data":
        modules.set(module.name, { data });
        break;
    }
  }

  return modules;
};
