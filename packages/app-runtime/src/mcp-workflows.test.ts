import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  createRequestStateCodec,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  answerWorkflow,
  presentWorkflow,
  workflowAnswers,
  workflowInstanceStatus,
  workflowReference,
  workflowRound,
  type WorkflowInstanceAccess,
  type WorkflowOutcome,
  type WorkflowRound,
} from "./mcp-workflows.ts";

const target = {
  appId: crypto.randomUUID(),
  hostname: "offers.apps.example.test",
  entrypoint: "Offers",
  workflow: "send-offer",
  id: "offer-42",
};

const prompt = (name: string, type: string) => ({
  name,
  type,
  message: `Send ${name}?`,
  requestedSchema: { type: "object" as const, properties: {} },
});

const fake = (...states: z.input<typeof workflowInstanceStatus>[]) => {
  const events: { requestId: string; event: { type: string; payload: unknown } }[] = [];
  let read = 0;

  const access: WorkflowInstanceAccess = {
    status: async () => workflowInstanceStatus.parse(states[Math.min(read++, states.length - 1)]),
    sendEvent: async (requestId, event) => {
      events.push({ requestId, event });
    },
  };

  return { access, events };
};

const minted: WorkflowRound[] = [];

const mint = async (round: WorkflowRound) => {
  minted.push(round);

  return `state-${minted.length}`;
};

describe("Workflow references", () => {
  it("accept only the exact reference shape", () => {
    const reference = { workflowInstance: { workflow: "send-offer", id: "offer-42" } };
    expect(workflowReference.safeParse(reference).success).toBe(true);
    expect(workflowReference.safeParse({ ...reference, extra: 1 }).success).toBe(false);
    expect(
      workflowReference.safeParse({ workflowInstance: { workflow: "send-offer" } }).success,
    ).toBe(false);
  });
});

describe("Presenting a Workflow to an MCP client", () => {
  it("asks every open prompt as form elicitation with signed state", async () => {
    const { access } = fake(
      { status: "queued" },
      { status: "running" },
      { status: "waiting", prompts: [prompt("approval", "approval")] },
    );

    const outcome = await presentWorkflow(target, access, mint, 5000);

    expect(outcome).toEqual({
      input: {
        resultType: "input_required",
        inputRequests: {
          "prompt-1": {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Send approval?",
              requestedSchema: { type: "object", properties: {} },
            },
          },
        },
        requestState: `state-${minted.length}`,
      },
    });
    const { round, ...signed } = z.object({ round: z.uuid() }).loose().parse(minted.at(-1));
    expect(round).not.toBe("");
    expect(signed).toEqual({
      ...target,
      prompts: [{ key: "prompt-1", name: "approval", type: "approval" }],
    });
  });

  it("lists open prompts in the result for clients without input requests", async () => {
    const { access } = fake({ status: "waiting", prompts: [prompt("approval", "approval")] });

    expect(await presentWorkflow(target, access, undefined)).toEqual({
      value: {
        workflowInstance: { workflow: "send-offer", id: "offer-42" },
        status: "waiting",
        prompts: [prompt("approval", "approval")],
      },
    });
  });

  it("returns the output, errors and an unfinished instance", async () => {
    expect(
      await presentWorkflow(
        target,
        fake({ status: "complete", output: { sent: true } }).access,
        mint,
      ),
    ).toEqual({ value: { sent: true } });

    await expect(
      presentWorkflow(target, fake({ status: "errored", error: { message: "boom" } }).access, mint),
    ).rejects.toThrow("Workflow failed: boom");

    await expect(
      presentWorkflow(target, fake({ status: "terminated" }).access, mint),
    ).rejects.toThrow("Workflow was terminated");

    expect(await presentWorkflow(target, fake({ status: "running" }).access, mint, 0)).toEqual({
      value: { workflowInstance: { workflow: "send-offer", id: "offer-42" }, status: "running" },
    });
  });
});

describe("Answering a Workflow from an MCP client", () => {
  const round = (prompts: WorkflowRound["prompts"]): WorkflowRound => ({
    ...target,
    round: crypto.randomUUID(),
    prompts,
  });

  it("sends each answer once with a request ID that is stable across retries", async () => {
    const answered = round([{ key: "prompt-1", name: "approval", type: "approval" }]);
    const answers = workflowAnswers.parse({ "prompt-1": { action: "accept", content: {} } });

    const first = fake(
      { status: "waiting", prompts: [prompt("approval", "approval")] },
      { status: "complete", output: 1 },
    );

    const retry = fake(
      { status: "waiting", prompts: [prompt("approval", "approval")] },
      { status: "complete", output: 1 },
    );

    expect(await answerWorkflow(answered, answers, first.access, mint)).toEqual({ value: 1 });
    await answerWorkflow(answered, answers, retry.access, mint);
    expect(first.events.map(({ event }) => event)).toEqual([
      { type: "approval", payload: { action: "accept", content: {} } },
    ]);
    // Management operations require UUID request IDs.
    expect(z.uuid().safeParse(first.events[0]?.requestId).success).toBe(true);
    expect(retry.events).toEqual(first.events);
  });

  it("skips closed prompts, invalid answers and a second answer for the same event type", async () => {
    const asked = round([
      { key: "prompt-1", name: "first", type: "shared" },
      { key: "prompt-2", name: "second", type: "shared" },
      { key: "prompt-3", name: "closed", type: "closed" },
      { key: "prompt-4", name: "invalid", type: "invalid" },
    ]);

    const answers = workflowAnswers.parse({
      "prompt-1": { action: "decline" },
      "prompt-2": { action: "accept" },
      "prompt-3": { action: "accept" },
      "prompt-4": { action: "approve" },
    });

    const { access, events } = fake(
      {
        status: "waiting",
        prompts: [
          prompt("first", "shared"),
          prompt("second", "shared"),
          prompt("invalid", "invalid"),
        ],
      },
      { status: "complete", output: null },
    );

    await answerWorkflow(asked, answers, access, mint);
    expect(answers["prompt-4"]).toBeUndefined();
    expect(events.map(({ event }) => event)).toEqual([
      { type: "shared", payload: { action: "decline" } },
    ]);
  });
});

describe("Workflow prompts through the MCP SDK", () => {
  // Mirrors the gateway: one handler per request, request state bound to its principal.
  const serve = (principal: string, access: WorkflowInstanceAccess) => {
    const codec = createRequestStateCodec<WorkflowRound>({
      key: "test-request-state-key-of-sufficient-length",
      bind: () => principal,
    });

    const respond = (outcome: WorkflowOutcome) =>
      "input" in outcome
        ? outcome.input
        : { content: [{ type: "text" as const, text: JSON.stringify(outcome.value) }] };

    return createMcpHandler(({ era }) => {
      const server = new McpServer(
        { name: "test", version: "1" },
        { requestState: { verify: (state, context) => codec.verify(state, context) } },
      );

      server.registerTool("call", { inputSchema: { id: z.string() } }, async (_input, context) => {
        const mint = (round: WorkflowRound) => codec.mint(round, context);

        if (context.mcpReq.requestState() !== undefined)
          return respond(
            await answerWorkflow(
              workflowRound.parse(context.mcpReq.requestState()),
              workflowAnswers.parse(context.mcpReq.inputResponses ?? {}),
              access,
              mint,
            ),
          );

        return respond(await presentWorkflow(target, access, era === "modern" ? mint : undefined));
      });

      return server;
    });
  };

  const message = z.object({
    result: z.looseObject({
      resultType: z.string().optional(),
      requestState: z.string().optional(),
      content: z.array(z.object({ text: z.string() })).optional(),
    }),
  });

  const call = async (
    handler: ReturnType<typeof serve>,
    version: "2026-07-28" | "2025-06-18",
    retry: { requestState?: string | undefined; inputResponses?: typeof answer } = {},
  ) => {
    const params = { name: "call", arguments: { id: "offer-42" }, ...retry };

    // 2026-07-28 requests carry the protocol envelope in _meta.
    if (version === "2026-07-28")
      Object.assign(params, {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: version,
          [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
          [CLIENT_INFO_META_KEY]: { name: "client", version: "1" },
        },
      });

    const response = await handler.fetch(
      new Request("https://mcp.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": version,
          "mcp-method": "tools/call",
          "mcp-name": "call",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params,
        }),
      }),
    );

    const body = await response.text();
    const line = body.split("\n").find((entry) => entry.startsWith("data: "));

    return z.json().parse(JSON.parse(line ? line.slice(6) : body));
  };

  const waiting = { status: "waiting", prompts: [prompt("approval", "approval")] };

  const answer = { "prompt-1": { action: "accept", content: {} } };

  it("asks, verifies the signed round and delivers the answer", async () => {
    const { access, events } = fake(waiting, waiting, { status: "complete", output: "sent" });
    const first = message.parse(await call(serve("alice", access), "2026-07-28"));
    expect(first.result.resultType).toBe("input_required");

    // Another principal and a modified state are refused before the handler runs.
    for (const [principal, requestState] of [
      ["bob", first.result.requestState],
      ["alice", `${first.result.requestState}x`],
    ])
      expect(
        await call(serve(principal ?? "", access), "2026-07-28", {
          requestState,
          inputResponses: answer,
        }),
      ).toMatchObject({ error: { code: -32602 } });

    expect(events).toEqual([]);

    const done = message.parse(
      await call(serve("alice", access), "2026-07-28", {
        requestState: first.result.requestState,
        inputResponses: answer,
      }),
    );

    expect(done.result.content).toEqual([{ text: JSON.stringify("sent") }]);
    expect(events.map(({ event }) => event)).toEqual([
      { type: "approval", payload: { action: "accept", content: {} } },
    ]);
  });

  it("returns open prompts to 2025-era clients without asking them", async () => {
    const { access } = fake(waiting);
    const result = message.parse(await call(serve("alice", access), "2025-06-18"));
    expect(result.result.resultType).toBeUndefined();

    expect(z.json().parse(JSON.parse(result.result.content?.[0]?.text ?? "null"))).toEqual({
      workflowInstance: { workflow: "send-offer", id: "offer-42" },
      status: "waiting",
      prompts: [prompt("approval", "approval")],
    });
  });
});
