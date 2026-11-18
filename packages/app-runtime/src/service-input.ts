import {
  inputAnswer,
  inputRequest,
  type InputAnswer,
  inputRequired,
  inputResponse,
  type InputField,
  type InputRequest,
  type InputResponse,
} from "@platform/contracts";
import { z } from "zod";
import type { AppValue } from "./app-rpc.ts";

// A person answers the question, often after reading or editing a form. No
// server state is held while they decide, so the lifetime only bounds replay.
const lifetimeMs = 24 * 60 * 60 * 1000;

const json = z.json();

// The call the answers belong to. Answers are delivered only to the same
// method with the same arguments, for the caller that received the question.
export type InputTarget = {
  appId: string;
  entrypoint: string;
  method: string;
  args: AppValue[];
};

const sealed = z.strictObject({
  version: z.literal(1),
  expiresAt: z.number(),
  binding: z.string(),
  target: z.string(),
  requests: z.record(z.string(), inputRequest),
  state: json.optional(),
});

const encoder = new TextEncoder();

const base64url = (data: Uint8Array) =>
  btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const unbase64url = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  );

// Encrypted, not only signed: the caller relays the provider's state without reading it.
const key = async (secret: string) => {
  const signing = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const material = await crypto.subtle.sign(
    "HMAC",
    signing,
    encoder.encode("widefleet-service-input/v1"),
  );

  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
};

// Arguments may hold values JSON cannot express; describe them deterministically.
const describe = (_name: string, value: AppValue): AppValue => {
  const big = z.bigint().safeParse(value);

  if (big.success) return { $bigint: big.data.toString() };

  if (value instanceof Map) return { $map: [...value.entries()] };

  if (value instanceof Set) return { $set: [...value.values()] };

  if (ArrayBuffer.isView(value))
    return { $bytes: base64url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };

  return value;
};

const fingerprint = async ({ appId, entrypoint, method, args }: InputTarget) => {
  const described = JSON.stringify([appId, entrypoint, method, args], describe);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(described));

  return base64url(new Uint8Array(digest));
};

const invalid = (cause?: Error) =>
  new Error("Invalid or expired input request state", cause ? { cause } : undefined);

const asking = z.looseObject({ resultType: z.literal("input_required") });

// Recognize a provider's question. Other results pass through unchanged.
export const requestedInput = (value: AppValue) => {
  if (!asking.safeParse(value).success) return undefined;
  const parsed = inputRequired.safeParse(value);

  if (!parsed.success)
    throw new Error(`Invalid input request: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });

  return parsed.data;
};

// Seal the provider's state for the caller that received the question.
export const sealInput = async (
  secret: string,
  binding: string,
  target: InputTarget,
  question: z.infer<typeof inputRequired>,
) => {
  const payload: z.infer<typeof sealed> = {
    version: 1,
    expiresAt: Date.now() + lifetimeMs,
    binding,
    target: await fingerprint(target),
    requests: question.inputRequests,
  };

  if (question.requestState !== undefined) payload.state = question.requestState;
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await key(secret),
      encoder.encode(JSON.stringify(payload)),
    ),
  );

  const token = new Uint8Array(iv.length + ciphertext.length);
  token.set(iv);
  token.set(ciphertext, iv.length);

  return {
    resultType: "input_required" as const,
    inputRequests: question.inputRequests,
    requestState: base64url(token),
  };
};

const fieldValue = (field: InputField) => {
  switch (field.type) {
    case "string": {
      let value = z.string();

      if (field.minLength !== undefined) value = value.min(field.minLength);

      if (field.maxLength !== undefined) value = value.max(field.maxLength);

      return field.enum ? value.refine((entry) => field.enum?.includes(entry)) : value;
    }

    case "number":
    case "integer": {
      let value = field.type === "integer" ? z.number().int() : z.number();

      if (field.minimum !== undefined) value = value.min(field.minimum);

      if (field.maximum !== undefined) value = value.max(field.maximum);

      return value;
    }

    case "boolean":
      return z.boolean();
  }
};

// Accepted content must match the form that was asked; anything else counts as unanswered.
const answer = (
  request: InputRequest,
  value: InputAnswer["inputResponses"][string] | undefined,
): InputResponse | undefined => {
  const response = inputResponse.safeParse(value);

  if (!response.success) return undefined;

  if (response.data.action !== "accept") return response.data;
  const { properties, required = [] } = request.requestedSchema;

  const form = z.strictObject(
    Object.fromEntries(
      Object.entries(properties).map(([name, field]) => [
        name,
        required.includes(name) ? fieldValue(field) : fieldValue(field).optional(),
      ]),
    ),
  );

  const content = form.safeParse(response.data.content);

  return content.success
    ? {
        action: "accept",
        content: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .parse(content.data),
      }
    : undefined;
};

// Open sealed state from a retried call and return what the provider receives
// as `ctx.props.input`.
export const openInput = async (
  secret: string,
  binding: string,
  target: InputTarget,
  input: InputAnswer,
) => {
  // The answer crossed an RPC or MCP boundary; check it again here.
  const parsed = inputAnswer.safeParse(input);

  if (!parsed.success) throw invalid();
  let payload;

  try {
    const token = unbase64url(parsed.data.requestState);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: token.slice(0, 12) },
      await key(secret),
      token.slice(12),
    );

    payload = sealed.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch (cause) {
    throw invalid(cause instanceof Error ? cause : undefined);
  }

  if (
    payload.expiresAt <= Date.now() ||
    payload.binding !== binding ||
    payload.target !== (await fingerprint(target))
  )
    throw invalid();

  const inputResponses: Record<string, InputResponse> = {};

  for (const [name, request] of Object.entries(payload.requests)) {
    const response = answer(request, parsed.data.inputResponses[name]);

    if (response) inputResponses[name] = response;
  }

  return { inputResponses, requestState: payload.state ?? null };
};
