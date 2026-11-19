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

type Canonical = string | Canonical[];

const scalar = z.union([
  z.boolean().transform((value): Canonical => ["boolean", String(value)]),
  // Zod numbers exclude NaN and infinities, which service RPC still carries.
  z
    .union([z.number(), z.nan(), z.literal([Infinity, -Infinity])])
    .transform((value): Canonical => ["number", Object.is(value, -0) ? "-0" : String(value)]),
  z.bigint().transform((value): Canonical => ["bigint", value.toString()]),
  z.string().transform((value): Canonical => ["string", value]),
]);

const appValue = z.custom<AppValue>();

const list = z.array(appValue);

const map = z.map(appValue, appValue);

const set = z.set(appValue);

const record = z.record(z.string(), appValue);

// Describe arguments with their types, so values that JSON would render alike,
// such as 42n and { $bigint: "42" } or typed arrays over the same bytes, differ.
const canonical = (value: AppValue, path = new Set<AppValue>()): Canonical => {
  if (value === null) return ["null"];

  if (value === undefined) return ["undefined"];
  const primitive = scalar.safeParse(value);

  if (primitive.success) return primitive.data;

  if (path.has(value))
    throw new Error("Arguments of a call that asks for input must not be cyclic");
  path.add(value);

  try {
    const items = list.safeParse(value);

    if (items.success) return ["array", ...items.data.map((item) => canonical(item, path))];
    const entries = map.safeParse(value);

    if (entries.success)
      return [
        "map",
        ...Array.from(entries.data, ([name, entry]) => [
          canonical(name, path),
          canonical(entry, path),
        ]),
      ];
    const members = set.safeParse(value);

    if (members.success)
      return ["set", ...Array.from(members.data, (item) => canonical(item, path))];

    if (ArrayBuffer.isView(value))
      return [
        "view",
        value.constructor.name,
        base64url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      ];

    if (value instanceof ArrayBuffer) return ["buffer", base64url(new Uint8Array(value))];

    if (value instanceof Date) return ["date", String(value.getTime())];

    if (value instanceof RegExp) return ["regexp", String(value)];

    if (value instanceof Error) return ["error", value.name, value.message];

    const fields = record.safeParse(value);

    // Service RPC carries no other objects: structured clone drops class prototypes.
    if (!fields.success) throw new Error("Unsupported argument in a call that asks for input");

    return [
      "object",
      ...Object.entries(fields.data).map(([name, entry]) => [name, canonical(entry, path)]),
    ];
  } finally {
    path.delete(value);
  }
};

const fingerprint = async ({ appId, entrypoint, method, args }: InputTarget) => {
  const described = JSON.stringify(canonical([appId, entrypoint, method, args]));
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

const seal = async (secret: string, payload: z.infer<typeof sealed>) => {
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
    inputRequests: payload.requests,
    requestState: base64url(token),
  };
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

  return seal(secret, payload);
};

const unseal = async (secret: string, binding: string, target: InputTarget, state: string) => {
  let payload;

  try {
    const token = unbase64url(state);

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

  return payload;
};

// Hand a question to another answering channel of the same caller, such as
// a form that the caller's client shows. The original lifetime still applies.
export const rebindInput = async (
  secret: string,
  from: string,
  to: string,
  target: InputTarget,
  state: string,
) => seal(secret, { ...(await unseal(secret, from, target, state)), binding: to });

const formats = {
  email: z.email(),
  uri: z.url(),
  date: z.iso.date(),
  "date-time": z.iso.datetime({ offset: true }),
};

const fieldValue = (field: InputField) => {
  switch (field.type) {
    case "string": {
      let value = z.string();

      if (field.minLength !== undefined) value = value.min(field.minLength);

      if (field.maxLength !== undefined) value = value.max(field.maxLength);

      if (field.format) {
        const format = formats[field.format];
        value = value.refine((entry) => format.safeParse(entry).success);
      }

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
  const payload = await unseal(secret, binding, target, parsed.data.requestState);

  const inputResponses: Record<string, InputResponse> = {};

  for (const [name, request] of Object.entries(payload.requests)) {
    const response = answer(request, parsed.data.inputResponses[name]);

    if (response) inputResponses[name] = response;
  }

  return { inputResponses, requestState: payload.state ?? null };
};
