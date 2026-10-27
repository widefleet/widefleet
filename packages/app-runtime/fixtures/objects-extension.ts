import { z } from "zod";
import { env } from "cloudflare:workers";
import type { RuntimeExtension } from "../src/runtime-extension.ts";

const createCollector = (): RuntimeExtension => {
  // A child importing this module fails at startup, before its first operation.
  z.object({ OBSERVER_LABEL: z.literal("parent-only-fixture") }).parse(env);

  return {
    async object(event, identity, binding) {
      const origin = binding("OBSERVER_ORIGIN", z.url());

      const response = await fetch(`${origin}/objects`, {
        method: "POST",
        body: JSON.stringify({ identity, event }),
      });

      await response.body?.cancel();

      if (!response.ok) throw new Error("Object observer fixture rejected");
    },
  };
};

export const runtimeExtension = createCollector();
