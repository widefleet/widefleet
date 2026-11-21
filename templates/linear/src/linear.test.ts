import { describe, expect, it } from "vitest";
import {
  callTool,
  LinearRequestError,
  linearServer,
  listTools,
  rpcRequest,
  rpcResult,
  toolOutput,
} from "./linear.ts";

const call = callTool({ name: "list_teams", arguments: { limit: 5 } });

const reply = (result: { content: { type: string; text: string }[]; isError?: boolean }) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result });

describe("Linear MCP requests", () => {
  it("sends one JSON-RPC request with the user's token", async () => {
    const request = rpcRequest(call, "token");
    expect(request.url).toBe(linearServer);
    expect(request.headers.get("authorization")).toBe("Bearer token");
    expect(request.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(await request.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_teams", arguments: { limit: 5 } },
    });
    expect(await rpcRequest(listTools("next"), "token").json()).toMatchObject({
      method: "tools/list",
      params: { cursor: "next" },
    });
  });

  it("reads results sent as JSON or as server-sent events", async () => {
    const text = { content: [{ type: "text", text: '{"teams":[]}' }] };

    expect(
      await rpcResult(
        call,
        new Response(reply(text), { headers: { "content-type": "application/json" } }),
      ),
    ).toEqual(text);

    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" });

    expect(
      await rpcResult(
        call,
        new Response(
          `event: message\r\ndata: ${notification}\r\n\r\nevent: message\r\ndata: ${reply(text)}\r\n\r\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ).toEqual(text);
  });

  it("parses JSON text and keeps every part as sent", () => {
    const start = { type: "text", text: '{"id":' };
    const end = { type: "text", text: '"ENG-1"}' };

    const image = {
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
      annotations: { audience: ["user"] },
    };

    expect(toolOutput({ content: [start, image, end] })).toEqual({
      status: "connected",
      result: null,
      content: [start, image, end],
    });
    expect(toolOutput({ content: [start, end] })).toEqual({
      status: "connected",
      result: { id: "ENG-1" },
      content: [start, end],
    });
    expect(toolOutput({ content: [{ type: "text", text: "Done" }] })).toMatchObject({
      result: null,
    });
  });

  it("keeps every field of parts, including parts of later protocol versions", async () => {
    expect(
      await rpcResult(
        call,
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "video", url: "x" }] },
        }),
      ),
    ).toEqual({ content: [{ type: "video", url: "x" }] });
  });

  it("lists tools with their schemas and hints", async () => {
    const schema = { type: "object", properties: { id: { type: "string" } } };

    expect(
      await rpcResult(
        listTools(),
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "get_issue", inputSchema: schema, annotations: { readOnlyHint: true } },
            ],
          },
        }),
      ),
    ).toEqual({
      tools: [
        {
          name: "get_issue",
          inputSchema: schema,
          annotations: { readOnlyHint: true },
        },
      ],
    });
  });

  it("separates tool errors from protocol errors", async () => {
    expect(
      toolOutput({ content: [{ type: "text", text: "Unknown team" }], isError: true }),
    ).toEqual({ status: "linear_error", message: "Unknown team" });
    await expect(
      rpcResult(
        call,
        Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Bad input" } }),
      ),
    ).rejects.toThrow(new LinearRequestError(-32602, "Bad input"));
    await expect(
      rpcResult(
        call,
        new Response("event: ping\n\n", { headers: { "content-type": "text/event-stream" } }),
      ),
    ).rejects.toThrow("Linear returned no result");
  });
});
