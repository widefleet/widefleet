import { z } from "zod";

/** Linear's hosted MCP server. Its tools are the connector's API. */
export const linearServer = "https://mcp.linear.app/mcp";

const json = z.json();

// MCP content parts. Parts of a later protocol version keep their type.
const contentPart = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.enum(["image", "audio"]), data: z.string(), mimeType: z.string() }),
  z.object({
    type: z.literal("resource_link"),
    uri: z.string(),
    name: z.string(),
    mimeType: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("resource"),
    resource: z.object({
      uri: z.string(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
      blob: z.string().optional(),
    }),
  }),
  z.object({ type: z.string() }),
]);

// Typed service bindings cannot map recursive JSON types, so schemas travel as
// JSON text, as tool results do.
const jsonText = json.transform((value) => JSON.stringify(value));

/** A Linear tool, with the hints that tell readers from writers. */
export const tool = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: jsonText,
  outputSchema: jsonText.optional(),
  annotations: z
    .object({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
});

export const toolList = z.object({ tools: z.array(tool), nextCursor: z.string().optional() });

export const toolCallResult = z.object({
  content: z.array(contentPart),
  isError: z.boolean().optional(),
});

export const toolCallInput = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  arguments: z.record(z.string(), json).default({}),
});

export type ToolCall = z.infer<typeof toolCallInput>;

/** One JSON-RPC request to Linear's server and the schema of its result. */
export type Rpc<Result extends z.ZodType> = {
  method: "tools/list" | "tools/call";
  params: ToolCall | { cursor?: string };
  result: Result;
};

export const listTools = (cursor?: string): Rpc<typeof toolList> => ({
  method: "tools/list",
  params: cursor ? { cursor } : {},
  result: toolList,
});

export const callTool = (call: ToolCall): Rpc<typeof toolCallResult> => ({
  method: "tools/call",
  params: call,
  result: toolCallResult,
});

// Linear's server is stateless: it answers each request on its own, without
// an initialized session, so every call is one JSON-RPC request.
export const rpcRequest = <Result extends z.ZodType>(rpc: Rpc<Result>, accessToken: string) =>
  new Request(linearServer, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: rpc.method, params: rpc.params }),
  });

const rpcSuccess = z.object({ id: z.literal(1), result: json });

const rpcError = z.object({
  id: z.literal(1),
  error: z.object({ code: z.number(), message: z.string() }),
});

// The server answers with one JSON-RPC message, as JSON or as a server-sent event.
const messages = (contentType: string, body: string) => {
  if (!contentType.startsWith("text/event-stream")) return [json.parse(JSON.parse(body))];

  return body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => json.parse(JSON.parse(data)));
};

/** A JSON-RPC error from Linear, such as an unknown tool or invalid arguments. */
export class LinearRequestError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Reads the response to a request built by `rpcRequest`. */
export const rpcResult = async <Result extends z.ZodType>(
  rpc: Rpc<Result>,
  response: Response,
): Promise<z.output<Result>> => {
  const body = await response.text();

  for (const candidate of messages(response.headers.get("content-type") ?? "", body)) {
    const failure = rpcError.safeParse(candidate);

    if (failure.success)
      throw new LinearRequestError(failure.data.error.code, failure.data.error.message);

    const parsed = rpcSuccess.safeParse(candidate);

    if (parsed.success) return rpc.result.parse(parsed.data.result);
  }

  throw new Error("Linear returned no result");
};

/**
 * A tool call's result. Linear's tools answer with JSON in `text`; `content`
 * keeps every part as the server sent it.
 */
export const toolOutput = (result: z.infer<typeof toolCallResult>) => {
  const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");

  if (result.isError) return { status: "linear_error", message: text } as const;

  return { status: "connected", text, content: result.content } as const;
};

/** The Linear account a token belongs to, as `get_user` reports it for "me". */
export const profile = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
