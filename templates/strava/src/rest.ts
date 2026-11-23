// Shared by the templates generated from OpenAPI descriptions: the template
// generator copies this file into each template's src. Edit it in
// packages/template-generator/src/runtime.
import { z } from "zod";
import { type Arguments, definedJson, InvalidRequest } from "./input.ts";
import type { JsonValue } from "./selection.ts";

/** How a method of a REST API is called, as src/schema.ts describes it. */
export type RestOperation = {
  httpMethod: string;
  path: string;
  /** Input names of path parameters, by the name the path uses. */
  pathParameters: Record<string, string>;
  /**
   * Query parameters by input name: the API's name, the separator that joins a
   * list into one value, or null to repeat the parameter, and whether it is required.
   */
  queryParameters: Record<string, [string, string | null, boolean]>;
  /** Header names by input name. */
  headerParameters: Record<string, string>;
  body: "json" | "form" | "multipart" | "text" | null;
  /** Form fields whose lists are joined into one value, with the separator; others repeat. */
  formLists?: Record<string, string> | undefined;
  bodyRequired: boolean;
  response: "json" | "binary" | null;
  pageable: boolean;
};

const own = <T>(record: Record<string, T>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const text = scalar.transform(String);

// A file a multipart form uploads: text, sent as UTF-8, or bytes as base64.
const upload = z
  .union([
    z.strictObject({ mimeType: z.string().min(1), text: z.string() }),
    z.strictObject({ mimeType: z.string().min(1), base64: z.base64() }),
  ])
  .transform(
    (file) =>
      new Blob(
        [
          "text" in file
            ? file.text
            : Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0)),
        ],
        { type: file.mimeType },
      ),
  );

// A form's fields as text, or in multipart forms also files: values, and lists
// of them, which repeat the field unless the operation joins them into one
// value. Fields passed as undefined are left out.
const formFields = <T>(
  method: string,
  operation: RestOperation,
  body: JsonValue,
  field: z.ZodType<T | string>,
  accepts: string,
) => {
  const fields = z.record(z.string(), z.union([field, z.array(field)]).optional()).safeParse(body);

  if (!fields.success) throw new InvalidRequest(`${method} takes its body as fields of ${accepts}`);

  return Object.entries(fields.data).flatMap(([name, value]): [string, T | string][] => {
    if (value === undefined) return [];
    const joiner = own(operation.formLists ?? {}, name);

    if (!Array.isArray(value)) return [[name, value]];

    if (joiner === undefined) return value.map((item) => [name, item]);
    const items = z.array(z.string()).safeParse(value);

    if (!items.success) throw new InvalidRequest(`${method}'s ${name} joins values, not files`);

    return [[name, items.data.join(joiner)]];
  });
};

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// An operation's path as a pattern of its pages' addresses: a parameter matches
// one segment, and a function such as `delta()` may carry arguments, as Graph's
// `delta(token='...')` links do. A function's argument may have another name in
// its links, as Graph writes `search(query='...')` for `search(q='...')`. The
// address may be percent-encoded.
const pathPattern = (path: string) => {
  const pattern = path
    .replace(/^\//, "")
    .split(/(\{[^}]+\})/)
    .map((part) =>
      /^\{[^}]+\}$/.test(part) ? "[^/]+" : literal(part).replace(/\\\(\w+=/g, "\\(\\w+="),
    )
    .join("")
    .replace(/\\\(\\\)$/, "(?:\\([^/]*\\))?");

  const matcher = new RegExp(`^${pattern}$`);

  return {
    test: (page: string) => {
      try {
        return matcher.test(page) || matcher.test(decodeURIComponent(page));
      } catch {
        return false;
      }
    },
  };
};

/**
 * The HTTP request for one method. Path parameters fill the path, header
 * inputs become headers, the others query parameters, and `body` is the
 * request body. The request is
 * checked against the method's parameters before anything is sent.
 */
export const restRequest = (
  base: string,
  method: string,
  operation: RestOperation,
  input: Arguments,
) => {
  // Optional arguments may be passed as undefined, which leaves them out.
  const values = z.record(z.string(), definedJson.optional()).parse(input);
  const pathNames = Object.values(operation.pathParameters);

  const known = new Set([
    ...pathNames,
    ...Object.keys(operation.queryParameters),
    ...Object.keys(operation.headerParameters),
    ...(operation.body ? ["body"] : []),
    ...(operation.body === "text" ? ["contentType"] : []),
    ...(operation.pageable ? ["nextLink"] : []),
  ]);

  for (const [key, value] of Object.entries(values))
    if (value !== undefined && !known.has(key))
      throw new InvalidRequest(`${method} has no argument ${key}`);

  const init: RequestInit = { method: operation.httpMethod };
  const headers: Record<string, string> = {};
  const body = own(values, "body");

  if (operation.bodyRequired && body === undefined)
    throw new InvalidRequest(`${method} needs a body`);

  if (operation.body === "json" && body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }

  // Fetch writes the form's media type, with the boundary of a multipart form.
  if (operation.body === "form" && body !== undefined)
    init.body = new URLSearchParams(formFields(method, operation, body, text, "values and lists"));

  if (operation.body === "multipart" && body !== undefined) {
    const form = new FormData();

    for (const [name, item] of formFields(
      method,
      operation,
      body,
      z.union([text, upload]),
      "values, lists and files",
    ))
      form.append(name, item);

    init.body = form;
  }

  if (operation.body === "text" && body !== undefined) {
    const text = z.string().safeParse(body);
    const contentType = z.string().optional().safeParse(own(values, "contentType"));

    if (!text.success || !contentType.success)
      throw new InvalidRequest(`${method} takes the body and its contentType as text`);
    init.body = text.data;
    headers["content-type"] = contentType.data ?? "application/octet-stream";
  }

  for (const [key, name] of Object.entries(operation.headerParameters)) {
    const value = own(values, key);

    if (value === undefined) continue;
    const text = z.string().safeParse(value);

    if (!text.success) throw new InvalidRequest(`${method}'s ${key} takes text`);
    headers[name] = text.data;
  }

  if (Object.keys(headers).length) init.headers = headers;

  // A later page continues at the address the API gave, on the API's origin.
  const nextLink = own(values, "nextLink");

  if (operation.pageable && nextLink !== undefined) {
    const next = z.url().safeParse(nextLink);

    // A later page of this operation: its path, with any parameter values and
    // query, so a link cannot read other data than the method does.
    const relative = next.success && next.data.startsWith(base) ? next.data.slice(base.length) : "";
    const page = /^[^?#]*/.exec(relative)?.[0] ?? "";

    if (!next.success || !pathPattern(operation.path).test(page))
      throw new InvalidRequest(`${method}'s nextLink must be a page address the API returned`);

    return { url: next.data, init };
  }

  // A value in quotes, as in OData's `search(q='{q}')`, doubles its own quotes.
  const path = operation.path.replace(/('?)\{([^}]+)\}/g, (_, quote: string, name: string) => {
    const key = own(operation.pathParameters, name);
    const value = scalar.safeParse(key === undefined ? undefined : own(values, key));

    if (!value.success) throw new InvalidRequest(`${method} needs ${key ?? name}`);
    const text = String(value.data);

    // `.` and `..` would move the request to another path.
    if (text === "." || text === "..") throw new InvalidRequest(`${method}'s ${key} is not an ID`);

    return `${quote}${encodeURIComponent(quote ? text.replaceAll("'", "''") : text)}`;
  });

  const url = new URL(path.replace(/^\//, ""), base);

  for (const [key, [name, separator, required]] of Object.entries(operation.queryParameters)) {
    const value = own(values, key);

    if (value === undefined && required) throw new InvalidRequest(`${method} needs ${key}`);

    if (value === undefined) continue;
    const list = Array.isArray(value) ? value : [value];

    const items = list.map((item) => {
      const parsed = scalar.safeParse(item);

      if (!parsed.success) throw new InvalidRequest(`${method}'s ${key} takes a value or a list`);

      return String(parsed.data);
    });

    if (separator === null) for (const item of items) url.searchParams.append(name, item);
    else url.searchParams.set(name, items.join(separator));
  }

  return { url: url.href, init };
};
