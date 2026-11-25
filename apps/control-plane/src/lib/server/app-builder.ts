// The control plane's client for the app builder (packages/app-builder).
// Hosted installations bind two builder Workers, one per phase; self-hosted
// installations reach one builder over a private network.
import {
  buildFailure,
  bundleResult,
  documentResult,
  encodeBase64,
  iconsResult,
  type documentRequest,
} from "@platform/contracts/builds";
import { Result } from "better-result";
import type { z } from "zod";
import type { Fetcher } from "@cloudflare/workers-types";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";

// Fetch and service binding responses, which have different nominal types.
type BuilderResponse = { status: number; ok: boolean; text: () => Promise<string> };

type Endpoint = (body: string, signal: AbortSignal) => Promise<BuilderResponse>;

// Builds take seconds; installing a large dependency graph can take minutes.
const defaultTimeout = 5 * 60 * 1000;

// Each phase answers within the deadline, also through service bindings,
// which cannot take the control plane's abort signal.
const before = <T>(promise: Promise<T>, signal: AbortSignal) =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);

const unavailable = (cause: unknown) =>
  new StorageUnavailable({ message: "The app builder is unavailable. Try again later.", cause });

const call = <T>(endpoint: Endpoint, body: string, schema: z.ZodType<T>, timeout: number) =>
  Result.gen(async function* () {
    const signal = AbortSignal.timeout(timeout);

    const response = yield* Result.await(
      Result.tryPromise({ try: () => before(endpoint(body, signal), signal), catch: unavailable }),
    );

    // The builder reports project errors, such as an invalid Wrangler file.
    if (response.status === 422) {
      const failure = yield* Result.await(
        Result.tryPromise({
          try: async () => buildFailure.parse(JSON.parse(await before(response.text(), signal))),
          catch: unavailable,
        }),
      );

      return yield* new InvalidOperation({ code: "BAD_REQUEST", message: failure.message });
    }

    if (!response.ok)
      return yield* unavailable(new Error(`The app builder answered HTTP ${response.status}`));

    const value = yield* Result.await(
      Result.tryPromise({
        try: async () => schema.parse(JSON.parse(await before(response.text(), signal))),
        catch: unavailable,
      }),
    );

    return Result.ok(value);
  });

export const createAppBuilder = (
  endpoints: { bundle: Endpoint; document: Endpoint; icons: Endpoint },
  timeout = defaultTimeout,
) => ({
  bundle: (files: Record<string, string>) =>
    call(endpoints.bundle, JSON.stringify({ files }), bundleResult, timeout),
  document: (request: z.input<typeof documentRequest>) =>
    call(endpoints.document, JSON.stringify(request), documentResult, timeout),
  icons: (svg: Uint8Array) =>
    call(endpoints.icons, JSON.stringify({ svg: encodeBase64(svg) }), iconsResult, timeout),
});

export type AppBuilder = ReturnType<typeof createAppBuilder>;

const headers = { "content-type": "application/json" };

/** One builder at an origin on a private network. */
export const httpAppBuilder = (origin: string) => {
  const endpoint = (path: string) => (body: string, signal: AbortSignal) =>
    fetch(new URL(path, origin), { method: "POST", headers, body, signal });

  return createAppBuilder({
    bundle: endpoint("/bundle"),
    document: endpoint("/document"),
    icons: endpoint("/icons"),
  });
};

/** Separate builder Workers per phase, so each phase runs in its own isolate. */
export const bindingAppBuilder = (bundler: Fetcher, documenter: Fetcher) =>
  createAppBuilder({
    bundle: (body) =>
      bundler.fetch("https://builder.internal/bundle", { method: "POST", headers, body }),
    document: (body) =>
      documenter.fetch("https://builder.internal/document", { method: "POST", headers, body }),
    icons: (body) =>
      documenter.fetch("https://builder.internal/icons", { method: "POST", headers, body }),
  });
