// Shared by the generated Google templates: the template generator copies this
// file into each template's src. Edit it in packages/template-generator/src/runtime.
import { z } from "zod";
import { type Arguments, definedJson, type FieldSelection, InvalidRequest } from "./input.ts";
import type { JsonValue } from "./selection.ts";

/** How a method of a Google API is called, as src/schema.ts describes it. */
export type GoogleOperation = {
  httpMethod: string;
  path: string;
  pathParameters: Record<string, string | null>;
  queryParameters: readonly string[];
  body: boolean;
  response: boolean;
};

const name = z.string().regex(/^[A-Za-z_][\w]*$/);

const selection = z.record(z.string(), z.json());

/**
 * Google's `fields` expression for a selection: `id,payload(headers,parts(mimeType))`.
 * Each field is returned with only the nested fields its selection names.
 */
export const fieldsExpression = (select: FieldSelection): string =>
  Object.entries(selection.parse(JSON.parse(JSON.stringify(select))))
    .map(([field, value]) => {
      if (!name.safeParse(field).success) throw new InvalidRequest(`Unknown field ${field}`);

      if (value === true) return field;
      const nested = selection.safeParse(value);

      if (!nested.success) throw new InvalidRequest(`Select ${field} with true or an object`);

      if (!Object.keys(nested.data).length)
        throw new InvalidRequest(`Select at least one field of ${field}`);

      return `${field}(${fieldsExpression(nested.data)})`;
    })
    .join(",");

const own = <T>(record: Record<string, T>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/**
 * The HTTP request for one method. Path parameters fill the path, the others
 * become query parameters, and `body` is the JSON request body. The request is
 * checked against the method's parameters before anything is sent.
 */
export const googleRequest = (
  base: string,
  method: string,
  operation: GoogleOperation,
  input: Arguments,
  select?: FieldSelection,
) => {
  // Optional arguments may be passed as undefined, which leaves them out.
  const values = z.record(z.string(), definedJson.optional()).parse(input);
  const known = new Set([...Object.keys(operation.pathParameters), ...operation.queryParameters]);

  for (const [key, value] of Object.entries(values))
    if (value !== undefined && !known.has(key) && !(key === "body" && operation.body))
      throw new InvalidRequest(`${method} has no argument ${key}`);

  const path = operation.path.replace(/\{\+?(\w+)\}/g, (_, key: string) => {
    const value = scalar.safeParse(own(values, key) ?? own(operation.pathParameters, key));

    if (!value.success) throw new InvalidRequest(`${method} needs ${key}`);

    // `.` and `..` would move the request to another path.
    if (value.data === "." || value.data === "..")
      throw new InvalidRequest(`${method}'s ${key} is not an ID`);

    return encodeURIComponent(String(value.data));
  });

  const url = new URL(path, base);

  for (const key of operation.queryParameters) {
    const value = own(values, key);

    if (value === undefined) continue;

    for (const item of Array.isArray(value) ? value : [value]) {
      const parsed = scalar.safeParse(item);

      if (!parsed.success) throw new InvalidRequest(`${method}'s ${key} takes a value or a list`);
      url.searchParams.append(key, String(parsed.data));
    }
  }

  if (operation.response) {
    if (!select) throw new InvalidRequest(`${method} needs a selection of the fields to return`);
    url.searchParams.set("fields", fieldsExpression(select));
  }

  const body: JsonValue | undefined = operation.body ? own(values, "body") : undefined;

  if (operation.body && body === undefined) throw new InvalidRequest(`${method} needs a body`);

  const init: RequestInit = { method: operation.httpMethod };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }

  return { url: url.href, init };
};

const googleError = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/** Google's error, with the reasons it states, from a failed response's body. */
export const googleErrorOf = (body: JsonValue | null) => {
  const parsed = googleError.safeParse(body);

  if (!parsed.success) return null;

  return {
    message: parsed.data.error.message,
    status: parsed.data.error.status ?? null,
    reasons: (parsed.data.error.errors ?? []).flatMap((entry) => entry.reason ?? []),
  };
};
