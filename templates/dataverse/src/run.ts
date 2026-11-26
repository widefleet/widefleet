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

// The service document names the environment's entity sets.
const serviceDocument = z.object({
  value: z.array(z.object({ name: z.string(), kind: z.string().optional() })),
});

type Connection = ReturnType<typeof accountConnection>;

/** The service root of the environment a request goes to. */
export const serviceRoot = (url: string) =>
  new URL(new URL(base.replace("{environment}", "environment")).pathname, url);

/**
 * The names of the environment's entity sets, from its service document, or
 * the result to return when it cannot be read.
 */
export const entitySets = async (environment: Environment, connection: Connection, url: string) => {
  const root = serviceRoot(url);
  const listed = await connection.send(root.href, { headers: { accept: "application/json" } });

  if (listed.status !== "connected") return { status: "failed", result: listed } as const;
  const read = await boundedJson(listed.response);

  if (read.status === "too_large") throw new Error("Dataverse's service document is too large");

  if (!listed.response.ok)
    return {
      status: "failed",
      result: failure(
        environment,
        listed.response,
        url,
        dataverseError.safeParse(read.body).data ?? null,
      ),
    } as const;

  const names = serviceDocument
    .parse(read.body)
    .value.filter((set) => (set.kind ?? "EntitySet") === "EntitySet")
    .map((set) => set.name);

  return { status: "read", names: new Set(names) } as const;
};

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
): Promise<DataverseResult<T>> =>
  runOperation<T>(environment, properties, method, operations[method], base, input);

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
  "Preference-Applied",
];

const headersOf = (response: Response) => {
  const present = answerHeaders.flatMap((name) => {
    const value = response.headers.get(name);

    return value === null ? [] : [[name, value] as const];
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

  // OData addresses a table and an unbound action the same way, and a related
  // collection and a bound action too, so a new row goes only to an entity set
  // the environment lists, through a navigation property, never to an action.
  // An action keeps its own method and the change it makes.
  if (method === "createRow" || method === "createRelatedRow") {
    // Bound actions are qualified by their namespace; navigation properties never
    // are. A key holds no further segments, except inside a quoted value.
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

    const sets = await entitySets(environment, connection, request.url);

    if (sets.status === "failed") return sets.result;

    if (!sets.names.has(z.string().parse(input["entitySet"])))
      throw new InvalidRequest(
        `${method}'s entitySet must be an entity set of the environment, such as accounts. Call actions with their own method or callAction.`,
      );
  }

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
