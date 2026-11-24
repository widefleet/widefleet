import { z } from "zod";
import { approvals, asks, changeQuestion } from "./approval.ts";
import { accountConnection } from "./connection.ts";
import { binaryContent } from "./content.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { type Arguments, boundedJson, definedJson, maximumResponseBytes } from "./input.ts";
import { restRequest } from "./rest.ts";
import type { QontoResult, ScaQuestion, ScaState } from "./results.ts";
import { base, operations } from "./schema.ts";

const scaState = z.object({
  scaSessionToken: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

// The user's answers when Widefleet calls again after a question: Widefleet's
// own approval, or Qonto's with the state its question returned.
const answers = z
  .object({
    inputResponses: z.object({
      approve: z.object({ action: z.enum(["accept", "decline", "cancel"]) }).optional(),
      approveInQonto: z.object({ action: z.enum(["accept", "decline", "cancel"]) }).optional(),
    }),
    requestState: scaState.nullable().optional(),
  })
  .optional();

/** Props of a call, with the user's answer when Widefleet calls again after a question. */
export type QontoProperties = Properties & { input?: z.input<typeof answers> };

const qontoError = z.union([
  z.object({
    errors: z.array(
      z.object({
        code: z.string(),
        detail: z.string().optional(),
        source: z
          .object({ pointer: z.string().optional(), parameter: z.string().optional() })
          .optional(),
      }),
    ),
    trace_id: z.string().optional(),
  }),
  // Approval answers name their error at the top level.
  z.object({ code: z.string(), message: z.string().optional() }).transform(({ code, message }) => ({
    errors: [{ code, detail: message }],
    trace_id: undefined,
  })),
]);

// Qonto asks for its own approval with HTTP 428 and the session the user approves.
const approvalRequired = z.object({ sca_session_token: z.string().min(1) });

const session = z.object({ result: z.string() });

const scaQuestion = (method: string, state: ScaState, waiting: boolean): ScaQuestion => ({
  resultType: "input_required",
  inputRequests: {
    approveInQonto: {
      message: `${waiting ? "Qonto has not received your approval yet. " : ""}Qonto asks you to approve "${method}" in the Qonto app on your paired phone. Approve it there within 15 minutes, then confirm here to finish.`,
      requestedSchema: { type: "object", properties: {} },
    },
  },
  requestState: state,
});

/**
 * Runs one Qonto operation for the current user. The request is checked
 * against the operation's parameters before anything is asked or sent. A change
 * asks the user first when their approval level says so, and runs only after
 * approval. When Qonto asks for its own approval on the user's paired phone,
 * the call asks the user to approve there and finishes once Qonto confirms it.
 */
export const run = async <T>(
  environment: Environment,
  properties: QontoProperties,
  method: keyof typeof operations,
  input: Arguments,
): Promise<QontoResult<T>> => {
  const operation = operations[method];
  const request = restRequest(base, method, operation, input);
  const connection = accountConnection(environment, properties);
  const connectUrl = environment.WIDEFLEET_ORIGIN;

  // Widefleet seals the state of a question for this method, its arguments and
  // this caller, so state here comes from an earlier round of this same call.
  const answered = answers.parse(properties.input);
  const pending = answered?.requestState ?? null;
  const headers = new Headers(request.init.headers);

  if (pending) {
    if (answered?.inputResponses.approveInQonto?.action !== "accept") return { status: "declined" };

    const sent = await connection.send(
      `${base}v2/sca_sessions/${encodeURIComponent(pending.scaSessionToken)}`,
      { method: "GET" },
    );

    if (sent.status !== "connected") return sent;
    const read = await boundedJson(sent.response);

    if (!sent.response.ok || read.status !== "read")
      throw new Error(`Qonto approval check failed (HTTP ${sent.response.status})`);

    const { result } = session.parse(read.body);

    if (result === "waiting") return scaQuestion(method, pending, true);

    // Qonto reports a refusal, and an approval that expired after 15 minutes, as `deny`.
    if (result !== "allow") return { status: "rejected_in_qonto" };
    headers.set("X-Qonto-Sca-Session-Token", pending.scaSessionToken);
  } else if (operation.change) {
    // A question only helps a user who can run the change afterwards.
    const status = await connection.status();

    if (status.status !== "connected") return status;
    const id = await callerId(caller.parse(properties.caller));

    if (asks(await approvals(environment.DB, id).level(), operation.change)) {
      const answer = answered?.inputResponses.approve;

      // The question shows the input as Qonto receives it.
      if (!answer)
        return changeQuestion("Qonto", method, operation.change, definedJson.parse(input));

      if (answer.action !== "accept") return { status: "declined" };
    }
  }

  // Every change carries an idempotency key, which Qonto requires for creating
  // payments, cards and attachments. The request that finishes after Qonto's
  // approval repeats the first one, key included.
  const idempotencyKey = pending?.idempotencyKey ?? crypto.randomUUID();

  if (operation.change) headers.set("X-Qonto-Idempotency-Key", idempotencyKey);

  const sent = await connection.send(request.url, { ...request.init, headers });

  if (sent.status !== "connected") return sent;
  const { response } = sent;

  if (response.status === 401) return { status: "reconnect_required", connectUrl };

  // Qonto answers 429 when the application's rate limit is reached.
  if (response.status === 429)
    return { status: "rate_limited", retryAfter: response.headers.get("retry-after") };

  const tooLarge = { status: "too_large", maximumBytes: maximumResponseBytes } as const;

  // Statements, certificates and invoices are files.
  if (operation.response === "binary" && response.ok) {
    const content = await binaryContent(response);

    // SAFETY: the generated signature types binary results as BinaryContent.
    return content ? { status: "connected", data: content as T } : tooLarge;
  }

  const read = await boundedJson(response);

  if (read.status === "too_large") return tooLarge;
  const { body } = read;

  if (response.ok)
    // SAFETY: Qonto answered with the result this operation describes, which its
    // generated signature types as T.
    return { status: "connected", data: (operation.response === "json" ? body : null) as T };

  const approval = approvalRequired.safeParse(body);

  if (response.status === 428 && approval.success)
    return scaQuestion(
      method,
      { scaSessionToken: approval.data.sca_session_token, idempotencyKey },
      false,
    );

  // A server error is an outage, not an answer about the request.
  if (response.status >= 500) throw new Error(`Qonto request failed (HTTP ${response.status})`);
  const error = qontoError.safeParse(body);

  if (!error.success) throw new Error(`Qonto request failed (HTTP ${response.status})`);

  return {
    status: "qonto_error",
    error: {
      status: response.status,
      errors: error.data.errors,
      traceId: error.data.trace_id ?? null,
    },
  };
};
