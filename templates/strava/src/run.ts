import { z } from "zod";
import { approvalAnswer, approvals, asks, changeQuestion } from "./approval.ts";
import { accountConnection } from "./connection.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { type Arguments, boundedJson, definedJson, maximumResponseBytes } from "./input.ts";
import { binaryContent } from "./content.ts";
import { restRequest } from "./rest.ts";
import type { StravaResult } from "./results.ts";
import { base, operations } from "./schema.ts";

/** Props of a call, with the user's answer when Widefleet calls again after a question. */
export type StravaProperties = Properties & { input?: z.input<typeof approvalAnswer> };

const stravaError = z.object({
  message: z.string(),
  errors: z
    .array(
      z.object({
        resource: z.string().optional(),
        field: z.string().optional(),
        code: z.string().optional(),
      }),
    )
    .default([]),
});

/**
 * Runs one Strava operation for the current user. The request is checked
 * against the operation's parameters before anything is asked or sent. A change
 * asks the user first when their approval level says so, and runs only after
 * approval.
 */
export const run = async <T>(
  environment: Environment,
  properties: StravaProperties,
  method: keyof typeof operations,
  input: Arguments,
): Promise<StravaResult<T>> => {
  const operation = operations[method];
  const request = restRequest(base, method, operation, input);
  const connection = accountConnection(environment, properties);

  if (operation.change) {
    // A question only helps a user who can run the change afterwards.
    const status = await connection.status();

    if (status.status !== "connected") return status;
    const id = await callerId(caller.parse(properties.caller));

    if (asks(await approvals(environment.DB, id).level(), operation.change)) {
      const answer = approvalAnswer.parse(properties.input)?.inputResponses.approve;

      // The question shows the input as Strava receives it.
      if (!answer)
        return changeQuestion("Strava", method, operation.change, definedJson.parse(input));

      if (answer.action !== "accept") return { status: "declined" };
    }
  }

  const sent = await connection.send(request.url, request.init);

  if (sent.status !== "connected") return sent;
  const { response } = sent;
  const connectUrl = environment.WIDEFLEET_ORIGIN;

  if (response.status === 401) return { status: "reconnect_required", connectUrl };

  // Strava answers 429 when the application's 15-minute or daily limit is reached.
  if (response.status === 429)
    return { status: "rate_limited", retryAfter: response.headers.get("retry-after") };

  const tooLarge = { status: "too_large", maximumBytes: maximumResponseBytes } as const;

  // Route exports are files.
  if (operation.response === "binary" && response.ok) {
    const content = await binaryContent(response);

    // SAFETY: the generated signature types binary results as BinaryContent.
    return content ? { status: "connected", data: content as T } : tooLarge;
  }

  const read = await boundedJson(response);

  if (read.status === "too_large") return tooLarge;
  const { body } = read;

  if (response.ok)
    // SAFETY: Strava answered with the result this operation describes, which its
    // generated signature types as T.
    return { status: "connected", data: (operation.response === "json" ? body : null) as T };

  const error = stravaError.safeParse(body);

  if (!error.success) throw new Error(`Strava request failed (HTTP ${response.status})`);

  return { status: "strava_error", error: { ...error.data, status: response.status } };
};
