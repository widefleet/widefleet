import { z } from "zod";
import type { RuntimeExtension } from "../src/runtime-extension.ts";

export const runtimeExtension: RuntimeExtension = {
  async keyValue(event, identity, binding) {
    const origin = binding("OBSERVER_ORIGIN", z.url());

    const response = await fetch(`${origin}/key-value`, {
      method: "POST",
      body: JSON.stringify({ identity, event }),
    });

    await response.body?.cancel();

    if (!response.ok) throw new Error("KV observer fixture rejected");
  },
  async tail(events, identity, binding) {
    const origin = binding("OBSERVER_ORIGIN", z.url());
    const label = binding("OBSERVER_LABEL", z.string());

    const response = await fetch(`${origin}/observer`, {
      method: "POST",
      body: JSON.stringify({
        identity,
        label,
        events: events.map(({ outcome, cpuTime, wallTime }) => ({ outcome, cpuTime, wallTime })),
      }),
    });

    await response.body?.cancel();

    if (!response.ok) throw new Error("Observer fixture rejected");
  },
};
