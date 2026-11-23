import { CodeMode, Tool } from "@opencode/codemode";
import { Effect, Schema } from "effect";
import { mcpServiceCall } from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";
import { callMcpService } from "./mcp-services.ts";
import { mcpPayloadLimit, mcpResultLimits } from "./mcp-media.ts";

const within = (limit: number, message: string) =>
  z.json().transform((value) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > limit)
      throw new Error(message);

    return value;
  });

const serviceInput = within(mcpResultLimits.json, "Service input exceeds 1 MiB");

// A service result may carry media the program returns as blocks; the final result is checked
// once they are lifted out.
const serviceResult = within(mcpPayloadLimit, "Service result exceeds 6 MiB; request less data");

export const executeMcpCode = async (
  environment: ParentEnvironment,
  context: ExecutionContext,
  token: string,
  code: string,
  signal: AbortSignal,
) => {
  const runtime = CodeMode.make({
    tools: {
      call: Tool.make({
        description: "Invoke a permitted app service with positional JSON arguments.",
        input: Schema.Unknown,
        output: Schema.Unknown,
        execute: (input) =>
          Effect.tryPromise(async () =>
            serviceResult.parse(
              (await callMcpService(
                environment,
                context,
                token,
                mcpServiceCall.parse(serviceInput.parse(input)),
              )) ?? null,
            ),
          ),
      }),
    },
    limits: { timeoutMs: 30_000, maxToolCalls: 32, maxOutputBytes: mcpPayloadLimit },
  });

  const result = await Effect.runPromise(runtime.execute(code), { signal });

  if (!result.ok)
    throw new Error(
      `${result.error.kind}: ${result.error.message}. Completed calls are not rolled back.`,
    );

  if (result.truncated) throw new Error("MCP result exceeds 6 MiB; return less data");

  return z.json().parse(result.value);
};
