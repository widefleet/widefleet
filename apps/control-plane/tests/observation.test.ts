import { afterEach, expect, it, vi } from "vitest";
import { observe, type Observation } from "../src/lib/server/observation.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("does not wait for an asynchronous capture or leak its rejection", async () => {
  const capture = vi.fn<Observation["capture"]>().mockRejectedValue(new Error("Unavailable"));
  const observer = { capture, close: async () => {} };
  const event = { event: "user_created", id: "fixture", userId: "fixture" } as const;
  expect(observe(observer, event)).toBeUndefined();
  capture.mockImplementation(() => new Promise<void>(() => {}));
  expect(observe(observer, event)).toBeUndefined();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(capture).toHaveBeenCalledTimes(2);
});
