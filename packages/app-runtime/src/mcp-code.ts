import { CodeMode, Tool } from "@opencode/codemode";
import { Effect, Schema } from "effect";
import { mcpServiceCall } from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";
import { invokeMcpService } from "./mcp-services.ts";
import { workflowReference, type WorkflowTarget } from "./mcp-workflows.ts";

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
  // Workflow references returned by services in this run, with the app that
  // returned them. A reference the program builds itself is never resolved.
  const issued: WorkflowTarget[] = [];

  const runtime = CodeMode.make({
    tools: {
      call: Tool.make({
        description: "Invoke a permitted app service with positional JSON arguments.",
        input: Schema.Unknown,
        output: Schema.Unknown,
        execute: (input) =>
          Effect.tryPromise(async () => {
            const call = mcpServiceCall.parse(mcpJson.parse(input));
            const { app, value } = await invokeMcpService(environment, context, token, call);
            const reference = workflowReference.safeParse(value);

            if (reference.success)
              issued.push({
                appId: app.appId,
                hostname: call.hostname,
                entrypoint: call.entrypoint,
                ...reference.data.workflowInstance,
              });

            return mcpJson.parse(value ?? null);
          }),
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
  const value = mcpJson.parse(result.value);
  const reference = workflowReference.safeParse(value);

  const matches = reference.success
    ? issued.filter(
        (target) =>
          target.workflow === reference.data.workflowInstance.workflow &&
          target.id === reference.data.workflowInstance.id,
      )
    : [];

  // Instance IDs are scoped per app: resolve only an unambiguous reference.
  const workflow =
    new Set(matches.map((target) => target.appId)).size === 1 ? matches[0] : undefined;

  return { value, workflow };
};
