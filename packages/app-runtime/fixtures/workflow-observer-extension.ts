import { env } from "cloudflare:workers";
import { z } from "zod";
import type { RuntimeExtension } from "../src/runtime-extension.ts";

// A child accidentally importing this module fails before it can run app code.
z.object({ OBSERVER_LABEL: z.literal("workflow-parent-only") }).parse(env);

export const runtimeExtension: RuntimeExtension = {
  async workflow(event, identity, binding) {
    const response = await fetch(binding("OBSERVER_ORIGIN", z.url()), {
      method: "POST",
      body: JSON.stringify({ event, identity }),
    });

    await response.body?.cancel();

    if (!response.ok) throw new Error("Workflow observer fixture rejected");
  },
};
