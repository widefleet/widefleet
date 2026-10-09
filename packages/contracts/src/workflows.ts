import { z } from "zod";

export const workflowName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/);

export const workflowInstanceId = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/);

export const workflowEventType = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/);

const request = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("list"),
    workflow: workflowName,
    cursor: z.string().max(256).optional(),
  }),
  z.strictObject({
    action: z.literal("create"),
    workflow: workflowName,
    id: workflowInstanceId,
    params: z.json().optional(),
  }),
  z.strictObject({
    action: z.enum(["status", "pause", "resume", "restart", "terminate", "delete"]),
    workflow: workflowName,
    id: workflowInstanceId,
  }),
  z.strictObject({
    action: z.literal("sendEvent"),
    workflow: workflowName,
    id: workflowInstanceId,
    event: z.strictObject({ type: workflowEventType, payload: z.json() }),
  }),
]);

export const workflowRequest = request.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 64 * 1024,
  "Management requests must not exceed 64 KiB",
);

export const workflowQuery = workflowRequest.refine(
  (value) => value.action === "list" || value.action === "status",
  "Only list and status are read operations",
);

export const workflowOperation = z.strictObject({
  id: z.uuid(),
  state: z.enum(["queued", "running", "succeeded", "failed"]),
  message: z.string().nullable(),
  result: z.json().nullable(),
});
