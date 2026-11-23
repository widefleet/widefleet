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
  requiredParameters: readonly string[];
  body: boolean;
  response: "json" | "content" | null;
  altMedia: boolean;
  upload: string | null;
};

const name = z.string().regex(/^[A-Za-z_][\w]*$/);

// A media type, without line breaks that would end the part's headers.
const mediaType = z.string().regex(/^[\w.+-]+\/[\w.+-]+(?:[ \t]*;[^\r\n]*)?$/);

// The charset a media type names, if any.
const charsetOf = (mimeType: string) => /;\s*charset="?([^";]+)"?/i.exec(mimeType)?.[1]?.trim();

const uploadContent = z.union([
  z.strictObject({ mimeType: mediaType, text: z.string() }),
  z.strictObject({ mimeType: mediaType, base64: z.base64() }),
]);

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

  const known = new Set([
    ...Object.keys(operation.pathParameters),
    ...operation.queryParameters,
    ...(operation.body ? ["body"] : []),
    ...(operation.upload ? ["content"] : []),
  ]);

  for (const [key, value] of Object.entries(values))
    if (value !== undefined && !known.has(key))
      throw new InvalidRequest(`${method} has no argument ${key}`);

  // An upload goes to the API's upload path, which starts at its root.
  const path = (operation.upload ?? operation.path).replace(/\{\+?(\w+)\}/g, (_, key: string) => {
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

    if (value === undefined && operation.requiredParameters.includes(key))
      throw new InvalidRequest(`${method} needs ${key}`);

    if (value === undefined) continue;

    for (const item of Array.isArray(value) ? value : [value]) {
      const parsed = scalar.safeParse(item);

      if (!parsed.success) throw new InvalidRequest(`${method}'s ${key} takes a value or a list`);
      url.searchParams.append(key, String(parsed.data));
    }
  }

  if (operation.response === "json") {
    if (!select) throw new InvalidRequest(`${method} needs a selection of the fields to return`);
    url.searchParams.set("fields", fieldsExpression(select));
  }

  if (operation.altMedia) url.searchParams.set("alt", "media");
  const body: JsonValue | undefined = operation.body ? own(values, "body") : undefined;
  const init: RequestInit = { method: operation.httpMethod };

  if (operation.upload) {
    const content = uploadContent.safeParse(own(values, "content"));

    if (!content.success)
      throw new InvalidRequest(`${method} needs content: a mimeType, and text or base64`);
    const charset = charsetOf(content.data.mimeType);

    // Text travels as UTF-8, so a media type naming another charset would
    // misdescribe its bytes.
    if ("text" in content.data && charset !== undefined && !/^utf-?8$/i.test(charset))
      throw new InvalidRequest(`${method} sends text as UTF-8; send ${charset} content as base64`);
    url.searchParams.set("uploadType", "multipart");
    const boundary = `widefleet-${crypto.randomUUID()}`;

    const encoded =
      "base64" in content.data
        ? `Content-Transfer-Encoding: base64\r\n\r\n${content.data.base64}`
        : `\r\n${content.data.text}`;

    init.body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(body ?? {}),
      `--${boundary}`,
      `Content-Type: ${content.data.mimeType}`,
      encoded,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    init.headers = { "content-type": `multipart/related; boundary=${boundary}` };

    return { url: url.href, init };
  }

  if (operation.body && body === undefined) throw new InvalidRequest(`${method} needs a body`);

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
