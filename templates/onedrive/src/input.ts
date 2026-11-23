// Shared by the generated templates: the template generator copies this file into
// each template's src. Edit it in packages/template-generator/src/runtime.
import { z } from "zod";
import type { JsonValue } from "./selection.ts";

/** A selection or input that does not match the API's description. */
export class InvalidRequest extends Error {}

/** JSON as typed inputs and selections hold it, where optional fields may be undefined. */
export type JsonInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonInput[]
  | { readonly [key: string]: JsonInput };

/** A method's arguments by name, as its generated signature types them. */
export type Arguments = Readonly<Record<string, JsonInput>>;

/** The fields to return, as `Selection` types them. */
export type FieldSelection = Readonly<Record<string, JsonInput>>;

// JSON values, leaving out undefined object fields at every depth as JSON does.
// Numbers must be finite: NaN or Infinity never turn into null.
export const definedJson: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(definedJson),
    z
      .record(z.string(), definedJson.optional())
      .transform((entries) =>
        Object.fromEntries(
          Object.entries(entries).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, value] as const],
          ),
        ),
      ),
  ]),
);

/**
 * Responses larger than this are not read: results are buffered between app
 * isolates, and a large body would exhaust the worker's memory.
 */
export const maximumResponseBytes = 8 * 1024 * 1024;

/** A response body up to `maximum` bytes, or null when it is larger. */
export const boundedBody = async (response: Response, maximum = maximumResponseBytes) => {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();

    return null;
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  // The declared length can be missing or wrong, so the stream is counted too.
  if (reader)
    try {
      while (true) {
        const chunk = await reader.read();

        if (chunk.done) break;
        const value = z.instanceof(Uint8Array).parse(chunk.value);
        length += value.byteLength;

        if (length > maximum) {
          await reader.cancel();

          return null;
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

  const data = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return data;
};

/**
 * A JSON response's body, null for other content, or `too_large` when it is
 * larger than `maximumResponseBytes`.
 */
export const boundedJson = async (response: Response) => {
  const bytes = await boundedBody(response);

  if (!bytes) return { status: "too_large" } as const;

  if (!response.headers.get("content-type")?.startsWith("application/json") || !bytes.byteLength)
    return { status: "read", body: null } as const;

  return {
    status: "read",
    body: definedJson.parse(JSON.parse(new TextDecoder().decode(bytes))),
  } as const;
};
