import { z } from "zod";

const text = z.string().min(1).max(256);

const description = z.string().max(1024);

// The flat primitive subset of MCP form elicitation, which HTML forms render too.
const inputField = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    title: text.optional(),
    description: description.optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    enum: z.array(text).min(1).max(100).optional(),
    enumNames: z.array(text).min(1).max(100).optional(),
    default: z.string().max(1024).optional(),
  }),
  z.strictObject({
    type: z.enum(["number", "integer"]),
    title: text.optional(),
    description: description.optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  }),
  z.strictObject({
    type: z.literal("boolean"),
    title: text.optional(),
    description: description.optional(),
    default: z.boolean().optional(),
  }),
]);

export type InputField = z.infer<typeof inputField>;

const inputName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/);

const bytes = <T>(value: T) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const inputRequest = z.strictObject({
  message: z.string().min(1).max(4096),
  requestedSchema: z
    .strictObject({
      type: z.literal("object"),
      properties: z.record(inputName, inputField),
      required: z.array(z.string()).optional(),
    })
    .refine((schema) => Object.keys(schema.properties).length <= 32, "At most 32 fields")
    .refine(
      (schema) => (schema.required ?? []).every((name) => Object.hasOwn(schema.properties, name)),
      "Required fields must be declared",
    )
    .default({ type: "object", properties: {} }),
});

export type InputRequest = z.infer<typeof inputRequest>;

const requests = z
  .record(inputName, inputRequest)
  .refine((value) => Object.keys(value).length >= 1, "At least one input request")
  .refine((value) => Object.keys(value).length <= 8, "At most 8 input requests")
  .refine((value) => bytes(value) <= 16 * 1024, "Input requests must not exceed 16 KiB");

// What a service method returns to ask its caller for input. The platform
// seals `requestState` before the caller sees it and returns it with the answers.
export const inputRequired = z.strictObject({
  resultType: z.literal("input_required"),
  inputRequests: requests,
  requestState: z
    .json()
    .refine((value) => bytes(value) <= 8 * 1024, "Request state must not exceed 8 KiB")
    .optional(),
});

// The same result after the platform sealed its state, as callers receive it.
export const sealedInputRequired = z.strictObject({
  resultType: z.literal("input_required"),
  inputRequests: requests,
  requestState: z
    .string()
    .min(1)
    .max(32 * 1024),
});

const content = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

// An answer to one input request, in MCP's elicitation result shape.
export const inputResponse = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept"), content: content.default({}) }),
  z.strictObject({ action: z.literal("decline") }),
  z.strictObject({ action: z.literal("cancel") }),
]);

export type InputResponse = z.infer<typeof inputResponse>;

// What a caller supplies with its retry.
export const inputAnswer = z.strictObject({
  inputResponses: z.record(z.string(), z.json()),
  requestState: z
    .string()
    .min(1)
    .max(32 * 1024),
});

export type InputAnswer = z.infer<typeof inputAnswer>;
