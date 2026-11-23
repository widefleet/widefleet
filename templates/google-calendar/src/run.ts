import { z } from "zod";
import { approvalAnswer, approvals, asks, changeQuestion } from "./approval.ts";
import { binaryContent } from "./content.ts";
import { accountConnection } from "./connection.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { googleErrorOf, googleRequest } from "./google.ts";
import {
  type Arguments,
  boundedJson,
  definedJson,
  type FieldSelection,
  maximumResponseBytes,
} from "./input.ts";
import type { GoogleCalendarResult } from "./results.ts";
import { base, type Operation, operations } from "./schema.ts";

/** Props of a call, with the user's answer when Widefleet calls again after a question. */
export type GoogleCalendarProperties = Properties & { input?: z.input<typeof approvalAnswer> };

// Google reports exhausted quotas as 403 with these reasons, and sometimes as 429.
const rateLimits = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);

/**
 * Runs one method of the Google Calendar API for the current user. The request is checked
 * against the method's parameters before anything is asked or sent. A change asks
 * the user first when their approval level says so, and runs only after approval.
 */
export const run = async <T>(
  environment: Environment,
  properties: GoogleCalendarProperties,
  method: keyof typeof operations,
  input: Arguments,
  select?: FieldSelection,
): Promise<GoogleCalendarResult<T>> => {
  const operation: Operation = operations[method];
  const request = googleRequest(base, method, operation, input, select);
  const connection = accountConnection(environment, properties);

  if (operation.change) {
    // A question only helps a user who can run the change afterwards.
    const status = await connection.status();

    if (status.status !== "connected") return status;
    const id = await callerId(caller.parse(properties.caller));

    if (asks(await approvals(environment.DB, id).level(), operation.change)) {
      const answer = approvalAnswer.parse(properties.input)?.inputResponses.approve;

      // The question shows the input as Google Calendar receives it.
      if (!answer)
        return changeQuestion(
          "Google Calendar",
          method,
          operation.change,
          definedJson.parse(input),
        );

      if (answer.action !== "accept") return { status: "declined" };
    }
  }

  const sent = await connection.send(request.url, request.init);

  if (sent.status !== "connected") return sent;
  const { response } = sent;
  const connectUrl = environment.WIDEFLEET_ORIGIN;

  if (response.status === 401) return { status: "reconnect_required", connectUrl };

  // A file's content, up to the size results can carry.
  if (operation.response === "content" && response.ok) {
    const content = await binaryContent(response);

    // SAFETY: the generated signature types content results as BinaryContent.
    return content
      ? { status: "connected", data: content as T }
      : { status: "too_large", maximumBytes: maximumResponseBytes };
  }

  const read = await boundedJson(response);

  if (read.status === "too_large")
    return { status: "too_large", maximumBytes: maximumResponseBytes };
  const { body } = read;

  if (response.ok)
    // SAFETY: Google Calendar answered the request written from this method's selection,
    // which its generated signature types as T.
    return { status: "connected", data: (operation.response === "json" ? body : null) as T };

  const error = googleErrorOf(body);

  if (response.status === 429 || error?.reasons.some((reason) => rateLimits.has(reason)))
    return { status: "rate_limited", retryAfter: response.headers.get("retry-after") };

  if (error?.reasons.includes("insufficientPermissions"))
    return { status: "permission_required", connectUrl };

  if (!error) throw new Error(`Google Calendar request failed (HTTP ${response.status})`);

  return {
    status: "calendar_error",
    error: {
      message: error.message,
      code: response.status,
      status: error.status,
      reasons: error.reasons,
    },
  };
};
