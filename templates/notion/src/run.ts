import { z } from "zod";
import { approvalAnswer, approvals, asks, changeQuestion } from "./approval.ts";
import { accountConnection } from "./connection.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import {
  type Arguments,
  boundedBody,
  boundedJson,
  definedJson,
  maximumResponseBytes,
} from "./input.ts";
import { restRequest } from "./rest.ts";
import type { NotionResult } from "./results.ts";
import { base, operations } from "./schema.ts";

/** Props of a call, with the user's answer when Widefleet calls again after a question. */
export type NotionProperties = Properties & { input?: z.input<typeof approvalAnswer> };

// Notion's errors name a stable code and explain it; some add details, such
// as which rate limit applied or whether a write that timed out was saved.
const notionError = z.object({
  object: z.literal("error"),
  code: z.string(),
  message: z.string(),
  request_id: z.string().optional(),
  additional_data: z.record(z.string(), z.json()).optional(),
});

// A stream of server-sent events, read to its end: the JSON envelope each
// event's data carries, such as Notion's `event.committed` and `stream.end`.
const streamedEvents = (text: string) =>
  text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");

    return data ? [definedJson.parse(JSON.parse(data))] : [];
  });

/**
 * Runs one Notion operation for the current user. The request is checked
 * against the operation's parameters before anything is asked or sent. A change
 * asks the user first when their approval level says so, and runs only after
 * approval.
 */
export const run = async <T>(
  environment: Environment,
  properties: NotionProperties,
  method: keyof typeof operations,
  input: Arguments,
  // `events` asks for the answer as server-sent events, under the name of the
  // method that offers them.
  answer: "json" | "events" = "json",
  name: string = method,
): Promise<NotionResult<T>> => {
  const operation = operations[method];
  const request = restRequest(base, name, operation, input);

  if (answer === "events") {
    const headers = new Headers(request.init.headers);
    headers.set("accept", "text/event-stream");
    request.init.headers = headers;
  }

  const connection = accountConnection(environment, properties);

  if (operation.change) {
    // A question only helps a user who can run the change afterwards.
    const status = await connection.status();

    if (status.status !== "connected") return status;
    const id = await callerId(caller.parse(properties.caller));

    if (asks(await approvals(environment.DB, id).level(), operation.change)) {
      const approval = approvalAnswer.parse(properties.input)?.inputResponses.approve;

      // The question shows the input as Notion receives it.
      if (!approval)
        return changeQuestion("Notion", name, operation.change, definedJson.parse(input));

      if (approval.action !== "accept") return { status: "declined" };
    }
  }

  const sent = await connection.send(request.url, request.init);

  if (sent.status !== "connected") return sent;
  const { response } = sent;
  const connectUrl = environment.WIDEFLEET_ORIGIN;

  if (response.status === 401) return { status: "reconnect_required", connectUrl };

  if (response.ok && response.headers.get("content-type")?.startsWith("text/event-stream")) {
    const bytes = await boundedBody(response);

    if (!bytes) return { status: "too_large", maximumBytes: maximumResponseBytes } as const;

    // SAFETY: Notion streamed the envelopes the method's signature types as T.
    return { status: "connected", data: streamedEvents(new TextDecoder().decode(bytes)) as T };
  }

  const read = await boundedJson(response);

  if (read.status === "too_large")
    return { status: "too_large", maximumBytes: maximumResponseBytes } as const;
  const { body } = read;

  if (response.ok)
    // SAFETY: Notion answered with the result this operation describes, which its
    // generated signature types as T.
    return { status: "connected", data: (operation.response === "json" ? body : null) as T };

  const error = notionError.safeParse(body);

  // Notion limits requests with 429 and answers 529 when it is overloaded;
  // both name the wait. A connection whose access Notion blocked gains nothing
  // from waiting.
  if (
    (response.status === 429 &&
      error.data?.additional_data?.["rate_limit_reason"] !== "public_api_request_blocked") ||
    response.status === 529
  )
    return { status: "rate_limited", retryAfter: response.headers.get("retry-after") };

  // A failure without Notion's error is an outage, not an answer about the
  // request. Notion's own errors, also its 5xx ones, are returned: a write that
  // timed out may have been saved, which its details say.
  if (!error.success) throw new Error(`Notion request failed (HTTP ${response.status})`);

  return {
    status: "notion_error",
    error: {
      status: response.status,
      code: error.data.code,
      message: error.data.message,
      requestId: error.data.request_id ?? null,
      additionalData: error.data.additional_data ?? null,
    },
  };
};
