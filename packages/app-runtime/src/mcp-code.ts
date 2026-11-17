import { WorkerEntrypoint } from "cloudflare:workers";
import { mcpServiceCall } from "@platform/contracts";
import { z } from "zod";
import type { ParentEnvironment } from "./types.ts";
import { callMcpService } from "./mcp-services.ts";

export const mcpJson = z.json().transform((result) => {
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 1024 * 1024)
    throw new Error("MCP result exceeds 1 MiB; request a smaller page");

  return result;
});

export const readMcpJson = async (message: Request | Response) => {
  const reader = message.body?.getReader();

  if (!reader) throw new Error("MCP requires a JSON body");
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;
      const value = z.instanceof(Uint8Array).parse(chunk.value);
      length += value.byteLength;

      if (length > 1024 * 1024) {
        await reader.cancel();
        throw new Error("MCP body exceeds 1 MiB; request a smaller page");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return mcpJson.parse(JSON.parse(new TextDecoder().decode(bytes)));
};

export class McpTools extends WorkerEntrypoint<
  ParentEnvironment,
  { token: string; deadline: number }
> {
  override async fetch(request: Request) {
    if (Date.now() >= this.ctx.props.deadline) throw new Error("Code execution expired");
    const input = mcpServiceCall.parse(await readMcpJson(request));

    return Response.json(
      mcpJson.parse(
        (await callMcpService(this.env, this.ctx, this.ctx.props.token, input)) ?? null,
      ),
    );
  }
}

export class McpOutbound extends WorkerEntrypoint {
  override fetch() {
    return new Response("Code mode has no network access", { status: 403 });
  }
}

export const executeMcpCode = async (
  environment: ParentEnvironment,
  context: ExecutionContext,
  token: string,
  code: string,
  signal: AbortSignal,
) => {
  const deadline = Date.now() + 30_000;
  const cancellation = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);

  const worker = environment.WIDEFLEET_LOADER.load({
    compatibilityDate: "2026-10-01",
    compatibilityFlags: [],
    mainModule: "main.js",
    modules: {
      "main.js": `export default { async fetch(request, env) {
      let calls = 0;
      const tools = Object.freeze({call: async (input) => {
        if (++calls > 32) throw new Error("Code mode permits at most 32 service calls");
        const response = await env.TOOLS.fetch("https://tools.invalid/call", {method:"POST",body:JSON.stringify(input),signal:request.signal});
        if (!response.ok) throw new Error("Service call failed");
        return response.json();
      }});
      const result = await (async (tools) => {\n${code}\n})(tools);
      return Response.json(result ?? null);
    }};`,
    },
    env: { TOOLS: context.exports.McpTools({ props: { token, deadline } }) },
    globalOutbound: context.exports.McpOutbound({ props: {} }),
  });

  try {
    const response = await worker
      .getEntrypoint(undefined, { limits: { cpuMs: 1000, subRequests: 32 } })
      .fetch(
        new Request("https://code.invalid/run", {
          method: "POST",
          signal: cancellation,
        }),
        // celld forwards cancellation only through the explicit subrequest option.
        { signal: cancellation },
      );

    if (!response.ok)
      throw new Error("Code execution failed; completed calls are not rolled back or replayed");

    return await readMcpJson(response);
  } finally {
    worker.dispose?.();
  }
};
