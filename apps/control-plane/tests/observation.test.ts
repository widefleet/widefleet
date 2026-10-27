import { afterEach, expect, it, vi } from "vitest";
import { closeObservation, observe, type Observation } from "../src/lib/server/observation.ts";
import { clientExtension } from "../src/lib/client-extension.ts";
import { updateClientContext, resetClientContext } from "../src/lib/client-observation.ts";
import { reportBrowserError, startBrowserReporting } from "../src/lib/reporting-client.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete clientExtension.update;
  delete clientExtension.reset;
  delete clientExtension.exception;
  delete clientExtension.start;
});

it("passes the original browser error to the installation observer", () => {
  const exception = vi.fn();
  clientExtension.exception = exception;

  const error = new TypeError("Cannot read deployment status", {
    cause: new Error("Connection refused"),
  });

  reportBrowserError(error);
  expect(exception.mock.calls[0]?.[0]).toBe(error);
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

it("absorbs rejected browser hooks while still cleaning up reporting", async () => {
  const fail = vi.fn(async () => {
    throw new Error("Unavailable");
  });

  clientExtension.update = fail;
  clientExtension.reset = fail;
  clientExtension.exception = fail;
  clientExtension.start = () => fail;
  const browser = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("window", browser);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
  );
  const stop = startBrowserReporting();
  updateClientContext({
    user: null,
    organization: null,
    role: null,
    route: null,
    url: "http://localhost/",
  });
  reportBrowserError(new Error("Synthetic"));
  resetClientContext();
  stop();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(fail).toHaveBeenCalledTimes(4);
  expect(browser.removeEventListener).toHaveBeenCalledTimes(2);
});

it("bounds a stalled flush and handles rejection even after its deadline", async () => {
  vi.useFakeTimers();
  let reject: ((reason: Error) => void) | undefined;

  const stalled = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });

  let closed = false;

  const closing = closeObservation({ capture: () => {}, close: () => stalled }).then(() => {
    closed = true;
  });

  await vi.advanceTimersByTimeAsync(1999);
  expect(closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await closing;
  expect(closed).toBe(true);
  reject?.(new Error("Late delivery failure"));
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["sync", "async"])("absorbs a %s flush failure and clears its deadline", async (mode) => {
  vi.useFakeTimers();
  await expect(
    closeObservation({
      capture: () => {},
      close: () => {
        if (mode === "async") return Promise.reject(new Error("Unavailable"));
        throw new Error("Unavailable");
      },
    }),
  ).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
