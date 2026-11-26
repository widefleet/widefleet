import { z } from "zod";
import type { Change } from "./approval.ts";
import type { JsonValue } from "./selection.ts";
import { operations } from "./schema.ts";

/** A path's segments, split at slashes outside quoted values. */
export const segments = (path: string) => {
  const parts = [""];
  let quoted = false;

  for (const character of path) {
    if (character === "'") quoted = !quoted;

    if (character === "/" && !quoted) parts.push("");
    else parts[parts.length - 1] += character;
  }

  return parts;
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A segment of an operation's path as a pattern: a parameter matches any
// segment, a key any key, and a function call any arguments.
const segmentPattern = (segment: string) => {
  if (/^\{[^}]+\}(\(\{[^}]+\}\))?$/.test(segment)) return "[^/]+";
  const open = segment.indexOf("(");

  return open === -1
    ? escaped(segment)
    : `${escaped(segment.slice(0, open))}\\(${segment.endsWith("({id})") ? "[^/]*" : ".*"}\\)`;
};

// The operations of a known address, such as `WinOpportunity` or a bound
// action of `emails`. The generic methods, whose every segment is a
// parameter, say nothing about what an address does.
const known = Object.values(operations).flatMap((operation) =>
  operation.path
    .split("/")
    .some(
      (segment) =>
        segment !== "" && !segment.startsWith("$") && !/^\{[^}]+\}(\(\{[^}]+\}\))?$/.test(segment),
    )
    ? [
        {
          httpMethod: operation.httpMethod,
          change: operation.change,
          pattern: new RegExp(
            `^${operation.path.replace(/^\//, "").split("/").map(segmentPattern).join("/")}$`,
            "i",
          ),
        },
      ]
    : [],
);

/**
 * The change a request to a path below the service root makes when a known
 * operation serves it: its change, null when it only reads, or undefined when
 * no known operation does.
 */
export const knownChange = (httpMethod: string, path: string): Change | null | undefined =>
  known.find((operation) => operation.httpMethod === httpMethod && operation.pattern.test(path))
    ?.change;

/**
 * Whether a new row's body changes existing rows: binding a collection of them,
 * as `Account_Tasks@odata.bind` does, or referring to one in a related list,
 * at any depth of a deep insert.
 */
export const changesExisting = (body: JsonValue | undefined): boolean => {
  if (Array.isArray(body)) return body.some((item) => changesExisting(item));
  const fields = z.record(z.string(), z.json()).safeParse(body);

  if (!fields.success) return false;

  return Object.entries(fields.data).some(
    ([key, value]) =>
      (key.endsWith("@odata.bind") && Array.isArray(value)) ||
      key === "@odata.id" ||
      changesExisting(value),
  );
};
