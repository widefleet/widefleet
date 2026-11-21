import { z } from "zod";

/** Linear's hosted MCP server. Its tools are the connector's API. */
export const linearServer = "https://mcp.linear.app/mcp";

const toolText = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
});

const rpcResponse = z.union([
  z.object({ id: z.literal(1), result: toolText }),
  z.object({ id: z.literal(1), error: z.object({ code: z.number(), message: z.string() }) }),
]);

const page = {
  limit: z.number().int().min(1).max(250).default(50),
  cursor: z.string().min(1).max(1024).optional(),
};

export const teamsInput = z.object({ query: z.string().min(1).max(256).optional(), ...page });

export const issuesInput = z.object({
  team: z.string().min(1).max(256).optional(),
  assignee: z.string().min(1).max(256).optional(),
  state: z.string().min(1).max(256).optional(),
  query: z.string().min(1).max(256).optional(),
  ...page,
});

export const issueInput = z.object({ id: z.string().min(1).max(256) });

// The tools the connector calls, with the inputs it sends them.
export const toolInputs = {
  list_teams: teamsInput,
  list_issues: issuesInput.extend({ fields: z.array(z.string()) }),
  get_issue: issueInput.extend({ fields: z.array(z.string()) }),
  get_user: z.object({ query: z.literal("me") }),
};

export type Tool = keyof typeof toolInputs;

// Linear's server is stateless: it answers each tool call on its own, without
// an initialized session, so every call is one JSON-RPC request.
export const toolRequest = <Name extends Tool>(
  name: Name,
  input: z.infer<(typeof toolInputs)[Name]>,
  accessToken: string,
) =>
  new Request(linearServer, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: input },
    }),
  });

// The server answers with one JSON-RPC message, as JSON or as a server-sent event.
const message = (contentType: string, body: string) => {
  if (!contentType.startsWith("text/event-stream")) return rpcResponse.parse(JSON.parse(body));

  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (!data) continue;
    const parsed = rpcResponse.safeParse(JSON.parse(data));

    if (parsed.success) return parsed.data;
  }

  throw new Error("Linear returned no tool result");
};

/** Reads a tool call's result: the tool's JSON output, or the error it reported. */
export const toolResult = async (response: Response) => {
  const reply = message(response.headers.get("content-type") ?? "", await response.text());

  if ("error" in reply) throw new Error(`Linear rejected the tool call (${reply.error.code})`);
  const text = reply.result.content.map((part) => part.text ?? "").join("");

  if (reply.result.isError) return { status: "linear_error", message: text } as const;

  return { status: "connected", output: z.json().parse(JSON.parse(text)) } as const;
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

// Requesting fields explicitly keeps the output shape stable: Linear returns
// null for a requested field without a value.
export const issueFields = [
  "id",
  "title",
  "status",
  "statusType",
  "priority",
  "url",
  "team",
  "teamId",
  "assigneeId",
  "createdAt",
  "updatedAt",
  "completedAt",
  "dueDate",
];

export const issue = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string().nullable(),
  statusType: z.string().nullable(),
  priority: z.object({ value: z.number(), name: z.string() }).nullable(),
  url: z.string().nullable(),
  team: z.string().nullable(),
  teamId: z.string().nullable(),
  assigneeId: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  dueDate: z.string().nullable(),
});

export const issueDetails = issue.extend({ description: z.string().nullable() });

export const team = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
});

export const nextPage = z.object({ hasNextPage: z.boolean(), cursor: z.string().optional() });
