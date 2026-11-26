import { z } from "zod";
import type { Change } from "./approval.ts";
import { accountConnection } from "./connection.ts";
import type { Environment } from "./context.ts";
import { boundedBody, definedJson, InvalidRequest, maximumResponseBytes } from "./input.ts";
import { restRequest } from "./rest.ts";
import type { DataverseResult } from "./results.ts";
import {
  approval,
  dataverseError,
  type DataverseProperties,
  entitySets,
  failure,
  serviceRoot,
  throttled,
} from "./run.ts";
import { base, operations } from "./schema.ts";
import type { JsonValue } from "./selection.ts";

/** One request of a batch. */
export interface BatchRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /**
   * The address relative to the service root, such as `accounts(<id>)` or
   * `accounts?$select=name`. In a change set, `$<contentId>` stands for the row
   * an earlier request of the set created, such as
   * `$1/contact_customer_accounts`.
   */
  url: string;
  /**
   * Request headers, as the methods send them, such as `Prefer`, `If-Match`,
   * `MSCRM.SolutionUniqueName` or `CallerObjectId`.
   */
  headers?: Record<string, string>;
  /** The JSON body. */
  body?: JsonValue;
  /** In a change set, the ID later requests of the set refer to as `$<contentId>`. */
  contentId?: string;
}

/** A batch's requests, and change sets of requests that all take effect or none. */
export interface BatchInput {
  /** The environment's host, such as `contoso.api.crm4.dynamics.com`, as `listEnvironments` returns it. */
  environment: string;
  /** Up to 1000 requests. A change set holds no GET. */
  requests: (BatchRequest | { changeSet: BatchRequest[] })[];
  /** Whether the requests after one that fails still run; by default the batch stops there. */
  continueOnError?: boolean;
}

/** The answer to one request of a batch, in the order of the requests. */
export interface BatchResponse {
  /** The request's `contentId`, for requests of a change set. */
  contentId?: string;
  status: number;
  /** The answer's headers, such as `OData-EntityId` with a created row's address. */
  headers: Record<string, string>;
  /** The answer's JSON, its text for other content, or null without content. */
  body: JsonValue;
}

// Each request goes with the user's own token, and its lines are the
// request's own; a header cannot replace the token or add lines.
const ownHeaders = new Set(["authorization", "host", "content-length"]);

const request = z.strictObject({
  method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: definedJson.optional(),
  contentId: z.string().regex(/^\w+$/).optional(),
});

const batchInput = z.strictObject({
  environment: z.string(),
  requests: z
    .array(z.union([request, z.strictObject({ changeSet: z.array(request).min(1) })]))
    .min(1),
  continueOnError: z.boolean().optional(),
});

type Request = z.infer<typeof request>;

// Dataverse runs up to 1000 requests in a batch.
const maximumRequests = 1000;

/** A path's segments, split at slashes outside quoted key values. */
const segments = (path: string) => {
  const parts = [""];
  let quoted = false;

  for (const character of path) {
    if (character === "'") quoted = !quoted;

    if (character === "/" && !quoted) parts.push("");
    else parts[parts.length - 1] += character;
  }

  return parts;
};

// The methods that address any table or action; their address, not their
// method, says what a request of a batch does.
const named = Object.values(operations).flatMap((operation) =>
  operation.change !== null &&
  operation.httpMethod === "POST" &&
  operation.path
    .split("/")
    .some(
      (segment) =>
        segment !== "" && !segment.startsWith("$") && !/^\{[^}]+\}(\(\{[^}]+\}\))?$/.test(segment),
    )
    ? [
        {
          change: operation.change,
          pattern: new RegExp(
            `^${operation.path
              .replace(/^\//, "")
              .split(/(\{[^}]+\})/)
              .map((part) =>
                /^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              )
              .join("")}$`,
            "i",
          ),
        },
      ]
    : [],
);

/** What a request changes, or null for one that only reads. */
const changeOf = (
  item: Request,
  path: string,
  sets: Set<string> | null,
  contentIds: ReadonlySet<string>,
): Change | null => {
  if (item.method === "GET") return null;
  const parts = segments(path);
  const root = /^[^(]*/.exec(parts[0] ?? "")?.[0] ?? "";
  const reference = root.startsWith("$");

  if (reference && !contentIds.has(root.slice(1)))
    throw new InvalidRequest(
      `batch's ${path} refers to ${root}, which no earlier request of its change set names`,
    );

  // A segment qualified by a namespace calls a bound action; a root that is no
  // entity set, an unbound one.
  const action =
    parts.some((part) => (/^[^(]*/.exec(part)?.[0] ?? "").includes(".")) ||
    (!reference && sets !== null && !sets.has(root));

  if (action) {
    const known = named.find((operation) => operation.pattern.test(path));

    // What a solution's action changes is unknown, so it counts as an update.
    return known?.change ?? "update";
  }

  if (item.method === "DELETE") return "delete";

  return item.method === "POST" && parts.at(-1) !== "$ref" ? "create" : "update";
};

const severity: Change[] = ["create", "update", "send", "delete"];

const crlf = "\r\n";

/** The body of a part of a multipart message, up to its closing boundary. */
const partsOf = (text: string, boundary: string) =>
  text
    .split(`--${boundary}`)
    .slice(1)
    .filter((part) => !part.startsWith("--"))
    .map((part) => part.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));

const headersOf = (text: string) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line.includes(":"))
      .map((line) => {
        const colon = line.indexOf(":");

        return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
      }),
  );

const split = (text: string) => {
  const match = /\r?\n\r?\n/.exec(text);

  return match
    ? { head: text.slice(0, match.index), rest: text.slice(match.index + match[0].length) }
    : { head: text, rest: "" };
};

const boundaryOf = (contentType: string | undefined) =>
  /boundary="?([^";]+)"?/i.exec(contentType ?? "")?.[1];

const header = (headers: Record<string, string>, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];

/** The answers of a multipart batch response, with those of change sets in order. */
const responsesOf = (text: string, boundary: string): BatchResponse[] =>
  partsOf(text, boundary).flatMap((part) => {
    const { head, rest } = split(part);
    const partHeaders = headersOf(head);
    const nested = boundaryOf(header(partHeaders, "content-type"));

    if (nested) return responsesOf(rest, nested);
    const { head: response, rest: content } = split(rest);
    const [statusLine = "", ...lines] = response.split(/\r?\n/);
    const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1]);

    if (!Number.isInteger(status)) throw new Error("Dataverse's batch response has no status");
    const headers = headersOf(lines.join("\n"));
    const body = content.trim();
    const json = (header(headers, "content-type") ?? "").startsWith("application/json");
    const contentId = header(partHeaders, "content-id");

    const answer: BatchResponse = {
      status,
      headers,
      body: body === "" ? null : json ? definedJson.parse(JSON.parse(body)) : body,
    };

    if (contentId !== undefined) answer.contentId = contentId;

    return [answer];
  });

/**
 * Runs a batch of Dataverse Web API requests for the current user, as one
 * `$batch` request. Changes ask once, for the batch, as its strongest change.
 */
export const batch = async (
  environment: Environment,
  properties: DataverseProperties,
  input: BatchInput,
): Promise<DataverseResult<{ responses: BatchResponse[] }>> => {
  const parsed = batchInput.safeParse(input);

  if (!parsed.success)
    throw new InvalidRequest(`batch's input is invalid: ${parsed.error.message}`);
  const { requests, continueOnError } = parsed.data;
  const items = requests.flatMap((item) => ("changeSet" in item ? item.changeSet : [item]));

  if (items.length > maximumRequests)
    throw new InvalidRequest(`batch runs up to ${maximumRequests} requests`);

  // The environment's host is checked as every method checks it.
  const root = serviceRoot(
    restRequest(base, "getMetadata", operations.getMetadata, { environment: input.environment })
      .url,
  );

  const connection = accountConnection(environment, properties);
  const status = await connection.status();

  if (status.status !== "connected") return status;

  // Each request's address on the environment, and its path below the service root.
  const address = (item: Request) => {
    if (/^[a-z][\w+.-]*:|^\/|^\$batch/i.test(item.url))
      throw new InvalidRequest(`batch's url ${item.url} must be relative to the service root`);

    const target = item.url.startsWith("$") ? null : new URL(item.url, root);

    if (target && !target.href.startsWith(root.href))
      throw new InvalidRequest(`batch's url ${item.url} leaves the service root`);

    // A line break would end the request's line or header and start another.
    if (/[\r\n]/.test(item.url) || (target === null && /\s/.test(item.url)))
      throw new InvalidRequest(`batch's url ${item.url} holds a line break or space`);

    for (const [name, value] of Object.entries(item.headers ?? {}))
      if (ownHeaders.has(name.toLowerCase()) || /[\r\n:]/.test(name) || /[\r\n]/.test(value))
        throw new InvalidRequest(`batch's requests cannot send the header ${name}`);

    const path = decodeURIComponent(
      (target ? target.pathname.slice(root.pathname.length) : item.url).replace(/\?.*$/, ""),
    );

    return { href: target?.href ?? item.url, path };
  };

  // Every request of a change set needs a Content-ID, unique in the batch;
  // those the input leaves out are numbered after the ones it names.
  const given = items.flatMap((item) => (item.contentId === undefined ? [] : [item.contentId]));

  if (new Set(given).size !== given.length)
    throw new InvalidRequest("batch's contentIds are unique in the batch");
  const taken = new Set(given);
  let next = 0;

  const numbered = (member: Request): Request => {
    if (member.contentId !== undefined) return member;

    do next += 1;
    while (taken.has(String(next)));

    return { ...member, contentId: String(next) };
  };

  const plan = requests.map((item) => {
    if (!("changeSet" in item)) {
      if (item.contentId !== undefined)
        throw new InvalidRequest("batch's contentId names requests of a change set");

      return { changeSet: null, items: [{ item, ...address(item) }] };
    }

    for (const member of item.changeSet)
      if (member.method === "GET") throw new InvalidRequest("batch's change sets hold no GET");

    return {
      changeSet: crypto.randomUUID(),
      items: item.changeSet.map((member) => ({ item: numbered(member), ...address(member) })),
    };
  });

  // Whether a new row goes to an entity set needs the environment's entity sets.
  const needsSets = plan.some((part) =>
    part.items.some(({ item, path }) => item.method !== "GET" && !path.startsWith("$")),
  );

  const sets = needsSets ? await entitySets(environment, connection, root.href) : null;

  if (sets?.status === "failed") return sets.result;

  const changes = plan.flatMap((part) => {
    const seen = new Set<string>();

    return part.items.flatMap(({ item, path }) => {
      const change = changeOf(item, path, sets?.names ?? null, seen);

      if (item.contentId !== undefined) seen.add(item.contentId);

      return change === null ? [] : [change];
    });
  });

  const strongest = changes.reduce<Change | null>(
    (current, change) =>
      current === null || severity.indexOf(change) > severity.indexOf(current) ? change : current,
    null,
  );

  if (strongest) {
    const asked = await approval(
      environment,
      properties,
      "batch",
      strongest,
      definedJson.parse(parsed.data),
    );

    if (asked) return asked;
  }

  const message = (item: Request, href: string) => {
    const lines = [`${item.method} ${href} HTTP/1.1`, "Accept: application/json"];

    for (const [name, value] of Object.entries(item.headers ?? {})) lines.push(`${name}: ${value}`);

    if (item.body !== undefined) lines.push("Content-Type: application/json; type=entry");

    return [
      "Content-Type: application/http",
      "Content-Transfer-Encoding: binary",
      ...(item.contentId === undefined ? [] : [`Content-ID: ${item.contentId}`]),
      "",
      ...lines,
      "",
      item.body === undefined ? "" : JSON.stringify(item.body),
    ].join(crlf);
  };

  const boundary = `batch_${crypto.randomUUID()}`;

  const body = [
    ...plan.map((part) => {
      if (part.changeSet === null) {
        const [only] = part.items;

        if (!only) throw new Error("A batch request is missing");

        return `--${boundary}${crlf}${message(only.item, only.href)}${crlf}`;
      }

      const inner = part.items
        .map(
          ({ item, href }) => `--changeset_${part.changeSet}${crlf}${message(item, href)}${crlf}`,
        )
        .join("");

      return `--${boundary}${crlf}Content-Type: multipart/mixed; boundary=changeset_${part.changeSet}${crlf}${crlf}${inner}--changeset_${part.changeSet}--${crlf}`;
    }),
    `--${boundary}--${crlf}`,
  ].join("");

  const url = new URL("$batch", root).href;

  const headers = new Headers({
    accept: "application/json",
    "content-type": `multipart/mixed; boundary=${boundary}`,
    "odata-version": "4.0",
    "odata-maxversion": "4.0",
  });

  if (continueOnError) headers.set("prefer", "odata.continue-on-error");
  const sent = await connection.send(url, { method: "POST", headers, body });

  if (sent.status !== "connected") return sent;
  const { response } = sent;

  if (response.status === 401 || throttled(response))
    return failure(environment, response, url, null);
  const bytes = await boundedBody(response);

  if (!bytes) return { status: "too_large", maximumBytes: maximumResponseBytes };
  const text = new TextDecoder().decode(bytes);
  const answerBoundary = boundaryOf(response.headers.get("content-type") ?? undefined);

  if (answerBoundary)
    return { status: "connected", data: { responses: responsesOf(text, answerBoundary) } };

  const error = (() => {
    try {
      return dataverseError.safeParse(JSON.parse(text)).data ?? null;
    } catch {
      return null;
    }
  })();

  return failure(environment, response, url, error);
};
