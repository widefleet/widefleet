import { describe, expect, it } from "vitest";
import { z } from "zod";
import { linearServer, toolRequest, toolResult } from "./linear.ts";

const reply = (result: { content: { type: string; text: string }[] }) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result });

const text = (value: z.infer<ReturnType<typeof z.json>>) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

describe("Linear tool calls", () => {
  it("sends one JSON-RPC tool call with the user's token", async () => {
    const request = toolRequest("list_teams", { limit: 5 }, "token");
    expect(request.url).toBe(linearServer);
    expect(request.headers.get("authorization")).toBe("Bearer token");
    expect(request.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(await request.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_teams", arguments: { limit: 5 } },
    });
  });

  it("reads results sent as JSON or as server-sent events", async () => {
    expect(
      await toolResult(
        new Response(reply(text({ teams: [] })), {
          headers: { "content-type": "application/json" },
        }),
      ),
    ).toEqual({ status: "connected", output: { teams: [] } });

    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" });

    expect(
      await toolResult(
        new Response(
          `event: message\r\ndata: ${notification}\r\n\r\nevent: message\r\ndata: ${reply(text({ id: "ENG-1" }))}\r\n\r\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ).toEqual({ status: "connected", output: { id: "ENG-1" } });
  });

  it("separates tool errors from protocol errors", async () => {
    expect(
      await toolResult(
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "Unknown team" }], isError: true },
        }),
      ),
    ).toEqual({ status: "linear_error", message: "Unknown team" });
    await expect(
      toolResult(
        Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Bad input" } }),
      ),
    ).rejects.toThrow("Linear rejected the tool call (-32602)");
    await expect(
      toolResult(
        new Response("event: ping\n\n", { headers: { "content-type": "text/event-stream" } }),
      ),
    ).rejects.toThrow("Linear returned no tool result");
  });
});
