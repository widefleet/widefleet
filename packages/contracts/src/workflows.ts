import { z } from "zod";

export const workflowName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/);

export const workflowInstanceId = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/);

export const workflowEventType = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/);

const promptText = z.string().min(1).max(256);

const promptField = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    title: promptText.optional(),
    description: z.string().max(1024).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    enum: z.array(promptText).min(1).max(100).optional(),
    enumNames: z.array(promptText).min(1).max(100).optional(),
    default: z.string().max(1024).optional(),
  }),
  z.strictObject({
    type: z.enum(["number", "integer"]),
    title: promptText.optional(),
    description: z.string().max(1024).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  }),
  z.strictObject({
    type: z.literal("boolean"),
    title: promptText.optional(),
    description: z.string().max(1024).optional(),
    default: z.boolean().optional(),
  }),
]);

const promptContent = {
  message: z.string().min(1).max(4096),
  requestedSchema: z
    .strictObject({
      type: z.literal("object"),
      properties: z.record(z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/), promptField),
      required: z.array(z.string()).optional(),
    })
    .refine((schema) => Object.keys(schema.properties).length <= 32, "At most 32 fields")
    .refine(
      (schema) => (schema.required ?? []).every((name) => Object.hasOwn(schema.properties, name)),
      "Required fields must be declared",
    )
    .default({ type: "object", properties: {} }),
};

const eventPrompt = z.strictObject(promptContent);

const fitsPromptLimit = (prompt: z.infer<typeof eventPrompt>) =>
  new TextEncoder().encode(JSON.stringify(prompt)).byteLength <= 16 * 1024;

// The question a person answers to release an event wait. The form is the
// flat primitive subset that MCP form elicitation and HTML forms both render.
export const workflowEventPrompt = eventPrompt.refine(
  fitsPromptLimit,
  "Prompts must not exceed 16 KiB",
);

export const workflowStepName = z
  .string()
  .max(256)
  .refine((value) => !Array.from(value).some((character) => character.charCodeAt(0) < 32));

// A prompt published by a waiting instance, as status reports it.
export const workflowPendingPrompt = z
  .strictObject({ name: workflowStepName, type: workflowEventType, ...promptContent })
  .refine(fitsPromptLimit, "Prompts must not exceed 16 KiB");

export const workflowRestartFrom = z.strictObject({
  name: workflowStepName,
  count: z.number().int().positive().default(1),
  type: z.enum(["do", "sleep", "waitForEvent"]).default("do"),
});

export const workflowRestartOptions = z.strictObject({ from: workflowRestartFrom.optional() });

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
    action: z.enum(["status", "pause", "resume", "terminate", "delete"]),
    workflow: workflowName,
    id: workflowInstanceId,
  }),
  workflowRestartOptions.extend({
    action: z.literal("restart"),
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
