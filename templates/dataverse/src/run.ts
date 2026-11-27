import { z } from "zod";
import { approvalAnswer, approvals, asks, type Change, changeQuestion } from "./approval.ts";
import { accountConnection } from "./connection.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import {
  type Arguments,
  boundedJson,
  definedJson,
  InvalidRequest,
  maximumResponseBytes,
} from "./input.ts";
import { changesExisting, knownChange } from "./classify.ts";
import { binaryContent } from "./content.ts";
import { type RestOperation, restRequest } from "./rest.ts";
import type { DataverseResult } from "./results.ts";
import type { JsonValue } from "./selection.ts";
import { base, operations } from "./schema.ts";

/** Props of a call, with the user's answer when Widefleet calls again after a question. */
export type DataverseProperties = Properties & { input?: z.input<typeof approvalAnswer> };

export const dataverseError = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** The service root of the environment a request goes to. */
export const serviceRoot = (url: string) =>
  new URL(new URL(base.replace("{environment}", "environment")).pathname, url);

/**
 * Whether a change may run: null when the user's approval level lets it run or
 * the user approved it, otherwise the question to ask or the declined result.
 */
export const approval = async (
  environment: Environment,
  properties: DataverseProperties,
  method: string,
  change: Change,
  input: JsonValue,
) => {
  const id = await callerId(caller.parse(properties.caller));

  if (!asks(await approvals(environment.DB, id).level(), change)) return null;
  const answer = approvalAnswer.parse(properties.input)?.inputResponses.approve;

  // The question shows the input as Dataverse receives it.
  if (!answer) return changeQuestion("Dataverse", method, change, input);

  return answer.action === "accept" ? null : ({ status: "declined" } as const);
};

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

  return runOperation<T>(
    environment,
    properties,
    method,
    { ...operation, change: changeOf(method, operation, input) },
    base,
    input,
  );
};

// Actions and functions called by name, whose address names the operation.
const byName = new Set([
  "callAction",
  "callTableAction",
  "callRowAction",
  "callFunction",
  "callTableFunction",
  "callRowFunction",
]);

/**
 * The change a call makes. OData addresses a table and an unbound action the
 * same way, so `createRow` may run an action and asks like one. A related row
 * goes through an unqualified navigation property, which no bound action is, so
 * creating it is a creation, unless its body binds existing rows. An action or
 * function called by name makes the change of the known operation it is, and an
 * unknown action counts as an update.
 */
const changeOf = (
  method: keyof typeof operations,
  operation: (typeof operations)[keyof typeof operations],
  input: Arguments,
): Change | null => {
  if (method === "createRelatedRow")
    return changesExisting(definedJson.optional().parse(input["body"])) ? "update" : "create";

  if (!byName.has(method)) return operation.change;
  const { url } = restRequest(base, method, operation, input);
  const path = decodeURIComponent(new URL(url).pathname.slice(serviceRoot(url).pathname.length));
  const known = knownChange(operation.httpMethod, path);

  return known === undefined ? operation.change : known;
};

// The headers Dataverse answers with that carry results: a created row's
// address, a chunked upload's address and chunk size, an elastic table's
// session token, a row's version and a file's name and size.
const answerHeaders = [
  "OData-EntityId",
  "Location",
  "x-ms-chunk-size",
  "x-ms-session-token",
  "ETag",
  "x-ms-file-name",
  "x-ms-file-size",
  "mimetype",
  "Preference-Applied",
];

// Dataverse sends a file's name in UTF-8, which Fetch reads one byte per character.
const utf8 = (value: string) => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(value, (character) => character.charCodeAt(0)),
    );
  } catch {
    return value;
  }
};

const headersOf = (response: Response) => {
  const present = answerHeaders.flatMap((name) => {
    const value = response.headers.get(name);

    return value === null ? [] : [[name, utf8(value)] as const];
  });

  return present.length ? { headers: Object.fromEntries(present) } : {};
};

/** Runs an operation at an address, such as one of the search endpoint's. */
export const runOperation = async <T>(
  environment: Environment,
  properties: DataverseProperties,
  method: string,
  operation: RestOperation & { change: Change | null },
  address: string,
  input: Arguments,
): Promise<DataverseResult<T>> => {
  const connection = accountConnection(environment, properties);
  // A question only helps a user who can run the change afterwards.
  const status = await connection.status();

  if (status.status !== "connected") return status;
  const request = restRequest(address, method, operation, input);

  // A related row is named by a key and an unqualified navigation property;
  // bound actions are qualified by their namespace. A key holds no further
  // segments, except inside a quoted value.
  if (
    method === "createRelatedRow" &&
    (z
      .string()
      .parse(input["id"])
      .replace(/'(?:[^']|'')*'/g, "''")
      .includes("/") ||
      !/^\w+$/.test(z.string().parse(input["navigationProperty"])))
  )
    throw new InvalidRequest(
      "createRelatedRow's navigationProperty must be a navigation property, such as Attributes. Call actions with their own method or callAction.",
    );

  if (operation.change) {
    const asked = await approval(
      environment,
      properties,
      method,
      operation.change,
      definedJson.parse(input),
    );

    if (asked) return asked;
  }

  const sent = await connection.send(request.url, request.init);

  if (sent.status !== "connected") return sent;
  const { response } = sent;

  if (response.status === 401 || throttled(response))
    return failure(environment, response, request.url, null);

  const tooLarge = { status: "too_large", maximumBytes: maximumResponseBytes } as const;

  // A row that did not change since the version `ifNoneMatch` names.
  if (response.status === 304) {
    await response.body?.cancel();

    return { status: "not_modified" };
  }

  // File content redirects to a temporary download address.
  if (operation.response === "binary" && (response.ok || response.status === 302)) {
    const content = await binaryContent(response);

    // SAFETY: the generated signature types binary results as BinaryContent.
    return content ? { status: "connected", data: content as T, ...headersOf(response) } : tooLarge;
  }

  const read = await boundedJson(response);

  if (read.status === "too_large") return tooLarge;
  const { body } = read;

  if (response.ok)
    // SAFETY: Dataverse answered with the result this operation describes, which its
    // generated signature types as T.
    return {
      status: "connected",
      data: (operation.response === "json" ? body : null) as T,
      ...headersOf(response),
    };

  return failure(environment, response, request.url, dataverseError.safeParse(body).data ?? null);
};

// Dataverse limits requests per user with 429.
export const throttled = (response: Response) =>
  response.status === 429 || (response.status === 503 && response.headers.has("retry-after"));

/** Why a request to an environment failed, so the user or an administrator can fix it. */
export const failure = (
  environment: Environment,
  response: Response,
  url: string,
  error: z.infer<typeof dataverseError> | null,
) => {
  if (response.status === 401)
    return { status: "reconnect_required", connectUrl: environment.WIDEFLEET_ORIGIN } as const;

  if (throttled(response))
    return { status: "rate_limited", retryAfter: response.headers.get("retry-after") } as const;

  if (error)
    return {
      status: "dataverse_error",
      error: { ...error.error, status: response.status },
    } as const;

  // Widefleet answers a destination the app may not reach with a plain 403.
  if (response.status === 403)
    return { status: "network_required", origin: new URL(url).origin } as const;

  throw new Error(`Dataverse request failed (HTTP ${response.status})`);
};
