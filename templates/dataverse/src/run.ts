import { z } from "zod";
import { approvalAnswer, approvals, asks, changeQuestion } from "./approval.ts";
import { accountConnection } from "./connection.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import {
  type Arguments,
  boundedJson,
  definedJson,
  InvalidRequest,
  maximumResponseBytes,
} from "./input.ts";
import { binaryContent } from "./content.ts";
import { restRequest } from "./rest.ts";
import type { DataverseResult } from "./results.ts";
import { base, operations } from "./schema.ts";

/** Props of a call, with the user's answer when Widefleet calls again after a question. */
export type DataverseProperties = Properties & { input?: z.input<typeof approvalAnswer> };

const dataverseError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

// The service document names the environment's entity sets.
const serviceDocument = z.object({
  value: z.array(z.object({ name: z.string(), kind: z.string().optional() })),
});

/**
 * Runs one Dataverse Web API operation for the current user in their
 * environment. The request is checked
 * against the operation's parameters before anything is asked or sent. A change
 * asks the user first when their approval level says so, and runs only after
 * approval.
 */
export const run = async <T>(
  environment: Environment,
  properties: DataverseProperties,
  method: keyof typeof operations,
  input: Arguments,
): Promise<DataverseResult<T>> => {
  const operation = operations[method];
  const connection = accountConnection(environment, properties);
  // A question only helps a user who can run the change afterwards.
  const status = await connection.status();

  if (status.status !== "connected") return status;
  const request = restRequest(base, method, operation, input);

  // OData addresses a table and an unbound action the same way, so a new row
  // goes only to an entity set the environment lists. An action keeps its own
  // method and the change it makes.
  if (method === "createRow") {
    const listed = await connection.send(new URL("./", request.url).href, {
      headers: { accept: "application/json" },
    });

    if (listed.status !== "connected") return listed;
    const read = await boundedJson(listed.response);

    if (!listed.response.ok || read.status === "too_large")
      throw new Error(`Dataverse service document failed (HTTP ${listed.response.status})`);
    const sets = serviceDocument.parse(read.body).value;

    if (
      !sets.some(
        (set) => set.name === input["entitySet"] && (set.kind ?? "EntitySet") === "EntitySet",
      )
    )
      throw new InvalidRequest(
        "createRow's entitySet must be an entity set of the environment, such as accounts. Call actions with their own method or callAction.",
      );
  }

  if (operation.change) {
    const id = await callerId(caller.parse(properties.caller));

    if (asks(await approvals(environment.DB, id).level(), operation.change)) {
      const answer = approvalAnswer.parse(properties.input)?.inputResponses.approve;

      // The question shows the input as Dataverse receives it.
      if (!answer)
        return changeQuestion("Dataverse", method, operation.change, definedJson.parse(input));

      if (answer.action !== "accept") return { status: "declined" };
    }
  }

  const sent = await connection.send(request.url, request.init);

  if (sent.status !== "connected") return sent;
  const { response } = sent;
  const connectUrl = environment.WIDEFLEET_ORIGIN;

  if (response.status === 401) return { status: "reconnect_required", connectUrl };

  // Dataverse limits requests per user with 429.
  if (response.status === 429 || (response.status === 503 && response.headers.has("retry-after")))
    return { status: "rate_limited", retryAfter: response.headers.get("retry-after") };

  const tooLarge = { status: "too_large", maximumBytes: maximumResponseBytes } as const;

  // File content redirects to a temporary download address.
  if (operation.response === "binary" && (response.ok || response.status === 302)) {
    const content = await binaryContent(response);

    // SAFETY: the generated signature types binary results as BinaryContent.
    return content ? { status: "connected", data: content as T } : tooLarge;
  }

  const read = await boundedJson(response);

  if (read.status === "too_large") return tooLarge;
  const { body } = read;

  if (response.ok)
    // SAFETY: Dataverse answered with the result this operation describes, which its
    // generated signature types as T.
    return { status: "connected", data: (operation.response === "json" ? body : null) as T };

  const error = dataverseError.safeParse(body);

  if (error.success)
    return { status: "dataverse_error", error: { ...error.data.error, status: response.status } };

  // Widefleet answers a destination the app may not reach with a plain 403.
  if (response.status === 403)
    return { status: "network_required", origin: new URL(request.url).origin };

  throw new Error(`Dataverse request failed (HTTP ${response.status})`);
};
