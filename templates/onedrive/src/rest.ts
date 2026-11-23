// Shared by the templates generated from OpenAPI descriptions: the template
// generator copies this file into each template's src. Edit it in
// packages/template-generator/src/runtime.
import { z } from "zod";
import {
  type Arguments,
  boundedBody,
  definedJson,
  InvalidRequest,
  maximumResponseBytes,
} from "./input.ts";

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
  body: "json" | "text" | null;
  bodyRequired: boolean;
  response: "json" | "binary" | null;
  pageable: boolean;
};

/**
 * File content: where to download it, when the API answers with a temporary
 * download address, or the content itself.
 */
export type BinaryContent =
  | { downloadUrl: string }
  | { contentType: string; data: Uint8Array<ArrayBuffer> };

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const own = <T>(record: Record<string, T>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * The HTTP request for one method. Path parameters fill the path, the others
 * become query parameters, and `body` is the request body. The request is
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
    ...(operation.body ? ["body"] : []),
    ...(operation.body === "text" ? ["contentType"] : []),
    ...(operation.pageable ? ["nextLink"] : []),
  ]);

  for (const [key, value] of Object.entries(values))
    if (value !== undefined && !known.has(key))
      throw new InvalidRequest(`${method} has no argument ${key}`);

  const init: RequestInit = { method: operation.httpMethod };
  const body = own(values, "body");

  if (operation.bodyRequired && body === undefined)
    throw new InvalidRequest(`${method} needs a body`);

  if (operation.body === "json" && body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }

  if (operation.body === "text" && body !== undefined) {
    const text = z.string().safeParse(body);
    const contentType = z.string().optional().safeParse(own(values, "contentType"));

    if (!text.success || !contentType.success)
      throw new InvalidRequest(`${method} takes the body and its contentType as text`);
    init.body = text.data;
    init.headers = { "content-type": contentType.data ?? "application/octet-stream" };
  }

  // A later page continues at the address the API gave, on the API's origin.
  const nextLink = own(values, "nextLink");

  if (operation.pageable && nextLink !== undefined) {
    const next = z.url().safeParse(nextLink);

    if (!next.success || !next.data.startsWith(base))
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

/**
 * The content of a binary response: the download address an API redirects to,
 * the content itself, or null when it is larger than `maximumResponseBytes`.
 */
export const binaryContent = async (response: Response): Promise<BinaryContent | null> => {
  const location = response.headers.get("location");

  if (response.status >= 300 && response.status < 400 && location) {
    await response.body?.cancel();

    return { downloadUrl: location };
  }

  const data = await boundedBody(response, maximumResponseBytes);

  if (!data) return null;

  return {
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    data,
  };
};
