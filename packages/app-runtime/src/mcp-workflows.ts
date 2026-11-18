import { inputRequired, type InputRequiredResult } from "@modelcontextprotocol/server";
import {
  workflowEventType,
  workflowInstanceId,
  workflowName,
  workflowPendingPrompt,
} from "@platform/contracts";
import { z } from "zod";

// A service method returns this value to hand a started Workflow instance to
// its MCP caller. The gateway resolves it only for the app it called.
export const workflowReference = z.strictObject({
  workflowInstance: z.strictObject({ workflow: workflowName, id: workflowInstanceId }),
});

export type WorkflowReference = z.infer<typeof workflowReference>;

// Integrity-protected by the request state codec and bound to the principal.
export const workflowRound = z.strictObject({
  appId: z.uuid(),
  hostname: z.string(),
  entrypoint: z.string(),
  workflow: workflowName,
  id: workflowInstanceId,
  round: z.uuid(),
  prompts: z.array(z.strictObject({ key: z.string(), name: z.string(), type: workflowEventType })),
});

export type WorkflowRound = z.infer<typeof workflowRound>;

export type WorkflowTarget = Omit<WorkflowRound, "round" | "prompts">;

const json = z.json();

type JsonValue = z.infer<typeof json>;

// The part of a catalog status the gateway reads. MCP results must be JSON.
export const workflowInstanceStatus = z.looseObject({
  status: z.string(),
  output: json.optional(),
  error: z.looseObject({ message: z.string() }).nullish(),
  prompts: z.array(workflowPendingPrompt).optional(),
});

type WorkflowInstanceStatus = z.infer<typeof workflowInstanceStatus>;

// The Workflow instance operations the gateway needs, scoped to one instance.
export type WorkflowInstanceAccess = {
  status(): Promise<WorkflowInstanceStatus>;
  sendEvent(requestId: string, event: { type: string; payload: JsonValue }): Promise<void>;
};

// The event payload a Workflow receives for an answer from an MCP client.
const elicitationAnswer = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), content: z.record(z.string(), json).optional() }),
  z.object({ action: z.literal("decline") }),
  z.object({ action: z.literal("cancel") }),
]);

// Client responses are untrusted; an invalid entry counts as unanswered.
export const workflowAnswers = z.record(z.string(), elicitationAnswer.optional().catch(undefined));

type WorkflowAnswers = z.infer<typeof workflowAnswers>;

// An instance that has not finished, as a caller without an open dialog sees it.
type UnfinishedWorkflow = WorkflowReference & {
  status: string;
  prompts?: WorkflowInstanceStatus["prompts"];
};

export type WorkflowOutcome = { input: InputRequiredResult } | { value: JsonValue };

const active = ["queued", "running", "waiting"];

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

// Wait until the instance asks something, ends or stays busy past the deadline.
const settle = async (access: WorkflowInstanceAccess, waitMs: number) => {
  const deadline = Date.now() + waitMs;

  for (;;) {
    const state = await access.status();

    if (state.prompts?.length || !active.includes(state.status) || Date.now() >= deadline)
      return state;
    await delay(250);
  }
};

// Request IDs are derived from the round so a retried answer never sends twice.
const answerRequestId = async (round: string, key: string) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${round}\0${key}`)),
  ).slice(0, 16);

  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// `mint` is absent for 2025-era clients: stateless serving cannot carry their
// server-to-client elicitation, so they receive the open prompts as a result.
export const presentWorkflow = async (
  target: WorkflowTarget,
  access: WorkflowInstanceAccess,
  mint: ((round: WorkflowRound) => Promise<string>) | undefined,
  waitMs = 10_000,
): Promise<WorkflowOutcome> => {
  const state = await settle(access, waitMs);

  if (state.prompts?.length && mint) {
    const prompts = state.prompts.map((prompt, index) => ({ key: `prompt-${index + 1}`, prompt }));

    return {
      input: inputRequired({
        inputRequests: Object.fromEntries(
          prompts.map(({ key, prompt }) => [
            key,
            inputRequired.elicit({
              message: prompt.message,
              requestedSchema: prompt.requestedSchema,
            }),
          ]),
        ),
        requestState: await mint({
          ...target,
          round: crypto.randomUUID(),
          prompts: prompts.map(({ key, prompt }) => ({
            key,
            name: prompt.name,
            type: prompt.type,
          })),
        }),
      }),
    };
  }

  if (state.status === "complete") return { value: state.output ?? null };

  if (state.status === "errored")
    throw new Error(`Workflow failed: ${state.error?.message ?? "unknown error"}`);

  if (state.status === "terminated") throw new Error("Workflow was terminated");

  // Still busy, paused or asking a legacy client: hand the reference back.
  const unfinished: UnfinishedWorkflow = {
    workflowInstance: { workflow: target.workflow, id: target.id },
    status: state.status,
  };

  if (state.prompts?.length) unfinished.prompts = state.prompts;

  return { value: json.parse(unfinished) };
};

// Deliver the client's answers for prompts that are still open, then continue.
export const answerWorkflow = async (
  round: WorkflowRound,
  answers: WorkflowAnswers,
  access: WorkflowInstanceAccess,
  mint: (round: WorkflowRound) => Promise<string>,
  waitMs = 10_000,
) => {
  const open = (await access.status()).prompts ?? [];
  const answered = new Set<string>();

  for (const { key, name, type } of round.prompts) {
    const answer = answers[key];

    // One event answers every open prompt of its type; never send a second.
    if (
      !answer ||
      answered.has(type) ||
      !open.some((prompt) => prompt.name === name && prompt.type === type)
    )
      continue;

    await access.sendEvent(await answerRequestId(round.round, key), {
      type,
      payload: json.parse(answer),
    });
    answered.add(type);
  }

  const { round: _round, prompts: _prompts, ...target } = round;

  return presentWorkflow(target, access, mint, waitMs);
};
