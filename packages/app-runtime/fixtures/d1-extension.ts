import { env } from "cloudflare:workers";
import { z } from "zod";
import type { RuntimeExtension } from "../src/runtime-extension.ts";

// A child that accidentally imports the initializer must fail to start.
const configuration = z.object({ D1_OBSERVER_ORIGIN: z.url() }).parse(env);

export const runtimeExtension: RuntimeExtension = {
  async database(event, identity) {
    const response = await fetch(configuration.D1_OBSERVER_ORIGIN, {
      method: "POST",
      body: JSON.stringify({ identity, event }),
    });

    await response.body?.cancel();

    if (!response.ok) throw new Error("D1 observer fixture rejected");
  },
};
