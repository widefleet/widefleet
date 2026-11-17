import { CodeMode, Tool } from "@opencode/codemode";
import { Effect, Schema } from "effect";
import { mcpServiceCall } from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";
import { callMcpService } from "./mcp-services.ts";

export const mcpJson = z.json().transform((result) => {
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 1024 * 1024)
    throw new Error("MCP result exceeds 1 MiB; request a smaller page");

  return result;
});

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
            mcpJson.parse(
              (await callMcpService(
                environment,
                context,
                token,
                mcpServiceCall.parse(mcpJson.parse(input)),
              )) ?? null,
            ),
          ),
      }),
    },
    limits: { timeoutMs: 30_000, maxToolCalls: 32, maxOutputBytes: 1024 * 1024 },
  });

  const result = await Effect.runPromise(runtime.execute(code), { signal });

  if (!result.ok)
    throw new Error(
      `${result.error.kind}: ${result.error.message}. Completed calls are not rolled back.`,
    );

  if (result.truncated) throw new Error("MCP result exceeds 1 MiB; request a smaller page");

  return mcpJson.parse(result.value);
};
