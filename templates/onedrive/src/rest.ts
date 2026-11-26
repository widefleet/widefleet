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
  /** Path parameters a call may leave out, by the name the path uses, such as an OData function's optional parameter. */
  optionalPathParameters?: string[] | undefined;
  /** Query inputs that are maps, each of whose fields is sent as its own parameter. */
  explodedParameters?: string[] | undefined;
  /**
   * Query parameters by input name: the API's name, the separator that joins a
   * list into one value, or null to repeat the parameter, and whether it is required.
   */
  queryParameters: Record<string, [string, string | null, boolean]>;
  /** Header names by input name. */
  headerParameters: Record<string, string>;
  body: "json" | "form" | "multipart" | "text" | "file" | null;
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

// An object a multipart form sends as a JSON part, as OpenAPI's default encoding does.
const jsonPart = z
  .record(z.string(), definedJson)
  .transform((value) => new Blob([JSON.stringify(value)], { type: "application/json" }));

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
// address may be percent-encoded. An optional segment, such as an OData type
// cast, may be missing.
const pathPattern = (path: string, optional: readonly string[]) => {
  const pattern = path
    .replace(/\/\{([^}]+)\}(?=\/|$)/g, (segment, name: string) =>
      optional.includes(name) ? "\0" : segment,
    )
    .replace(/^\//, "")
    .split(/(\{[^}]+\})/)
    .map((part) =>
      /^\{[^}]+\}$/.test(part) ? "[^/]+" : literal(part).replace(/\\\(\w+=/g, "\\(\\w+="),
    )
    .join("")
    .replaceAll("\0", "(?:/[^/]+)?")
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

  // A server variable, such as the host of a customer's environment, is an
  // input of every method. It holds a host or a name, never a path.
  const serverNames = [...base.matchAll(/\{(\w+)\}/g)].map(([, name = ""]) => name);

  const address = base.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = z
      .string()
      .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/)
      .safeParse(own(values, name));

    if (!value.success) throw new InvalidRequest(`${method} needs ${name}, a host name`);

    return value.data;
  });

  const known = new Set([
    ...serverNames,
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
      z.union([text, upload, jsonPart]),
      "values, lists, files and objects",
    ))
      form.append(name, item);

    init.body = form;
  }

  // A file is sent as its bytes, with its media type.
  if (operation.body === "file" && body !== undefined) {
    const file = upload.safeParse(body);

    if (!file.success)
      throw new InvalidRequest(`${method} takes the body as a file with its mimeType`);
    init.body = file.data;
    headers["content-type"] = file.data.type;
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
    const relative =
      next.success && next.data.startsWith(address) ? next.data.slice(address.length) : "";

    const page = /^[^?#]*/.exec(relative)?.[0] ?? "";

    if (
      !next.success ||
      !pathPattern(operation.path, operation.optionalPathParameters ?? []).test(page)
    )
      throw new InvalidRequest(`${method}'s nextLink must be a page address the API returned`);

    return { url: next.data, init };
  }

  const absent = (name: string) => {
    const key = own(operation.pathParameters, name);

    return (
      operation.optionalPathParameters?.includes(name) === true &&
      key !== undefined &&
      own(values, key) === undefined
    );
  };

  // An optional segment without a value is left out, as an OData type cast,
  // and so is an OData function's optional parameter, as in `f(a={a},b='{b}')`
  // without `b`.
  const called = operation.path
    .replace(/\/\{([^}]+)\}(?=\/|$)/g, (segment, name: string) => (absent(name) ? "" : segment))
    .replace(
      /([(,])(\w+)=[^,()]*\{(\w+)\}[^,()]*(?=[,)])/g,
      (piece, before: string, _, name: string) => (absent(name) ? before : piece),
    )
    .replace(/\(,+/g, "(")
    .replace(/,+\)/g, ")")
    .replace(/,{2,}/g, ",");

  // A value in quotes, as in OData's `search(q='{q}')`, doubles its own quotes.
  const path = called.replace(/('?)\{([^}]+)\}/g, (_, quote: string, name: string) => {
    const key = own(operation.pathParameters, name);
    const value = scalar.safeParse(key === undefined ? undefined : own(values, key));

    if (!value.success) throw new InvalidRequest(`${method} needs ${key ?? name}`);
    const text = String(value.data);

    // `.` and `..` would move the request to another path, and an empty value
    // would leave out its segment.
    if (text === "" || text === "." || text === "..")
      throw new InvalidRequest(`${method}'s ${key} is not an ID`);

    return `${quote}${encodeURIComponent(quote ? text.replaceAll("'", "''") : text)}`;
  });

  const url = new URL(path.replace(/^\//, ""), address);

  for (const [key, [name, separator, required]] of Object.entries(operation.queryParameters)) {
    const value = own(values, key);

    if (value === undefined && required) throw new InvalidRequest(`${method} needs ${key}`);

    if (value === undefined) continue;

    // An OData parameter alias, such as `@Target`, carries any value as JSON.
    if (name.startsWith("@")) {
      url.searchParams.set(name, JSON.stringify(value));
      continue;
    }

    // An object that repeats sends each of its fields as a parameter, as
    // OpenAPI's exploded form style does, such as OData's parameter aliases.
    if (operation.explodedParameters?.includes(key)) {
      const fields = z.record(z.string(), definedJson).safeParse(value);

      if (!fields.success) throw new InvalidRequest(`${method}'s ${key} takes values by name`);

      for (const [field, item] of Object.entries(fields.data)) {
        const parsed = scalar.safeParse(item);

        if (!parsed.success) throw new InvalidRequest(`${method}'s ${key} takes values`);
        url.searchParams.append(field, String(parsed.data));
      }

      continue;
    }

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
