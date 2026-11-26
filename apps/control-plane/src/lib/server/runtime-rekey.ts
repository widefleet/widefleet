import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { z } from "zod";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";
import type { Principal } from "./identity.ts";

/** The app runtime's management path that rewrites one page of its storage. */
export const runtimeRekeyPath = "/.well-known/widefleet/rekey";

/** Sends one page request to the app runtime's management endpoint. */
export type RuntimeRekeyRequest = (
  input: z.infer<typeof contract.runtimeRekeyInput>,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const rekeyResponse = z.object({ result: contract.runtimeRekeyPage });

// Rewriting reaches the stored values of every app, so only installation
// administrators run it. The caller drives the pages, so each request stays
// within the runtime's limits.
export const createRuntimeRekey = (request?: RuntimeRekeyRequest) => ({
  page: (principal: Principal, input: z.infer<typeof contract.runtimeRekeyInput>) =>
    Result.tryPromise({
      try: async () => {
        if (!principal.admin)
          throw new InvalidOperation({
            code: "FORBIDDEN",
            message: "Administrator permission is required",
          });

        if (!request)
          throw new InvalidOperation({
            code: "CONFLICT",
            message: "This installation has no app runtime to rewrite",
          });

        const response = await request(contract.runtimeRekeyInput.parse(input));

        if (!response.ok)
          throw new StorageUnavailable({
            message: `The app runtime could not rewrite its storage (status ${response.status})`,
            cause: null,
          });

        return rekeyResponse.parse(JSON.parse(await response.text())).result;
      },
      catch: (cause) =>
        cause instanceof InvalidOperation || cause instanceof StorageUnavailable
          ? cause
          : new StorageUnavailable({
              message: "The app runtime could not rewrite its storage",
              cause,
            }),
    }),
});
