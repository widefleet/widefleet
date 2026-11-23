import { z } from "zod";
import type { Json } from "./types.ts";

const mebibyte = 1024 * 1024;

/** Limits of one MCP tool result: its JSON text, and the media blocks lifted out of it. */
export const mcpResultLimits = { json: mebibyte, media: 5 * mebibyte } as const;

/** The largest value a service call or program may hand over before media is lifted out. */
export const mcpPayloadLimit = mcpResultLimits.json + mcpResultLimits.media;

const base64 = z
  .string()
  // Services return base64url (Gmail), unpadded or line-wrapped data; MCP takes padded standard base64.
  .transform((data) => {
    const compact = data.replaceAll(/\s/g, "").replaceAll("-", "+").replaceAll("_", "/");

    return compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
  })
  .pipe(z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/));

const mimeType = z.string().regex(/^[\w.+-]+\/[\w.+-]+(?:\s*;.*)?$/);

// MCP metadata a content block may carry; other fields stay in the JSON only.
const annotations = z
  .object({
    audience: z.array(z.enum(["user", "assistant"])).optional(),
    priority: z.number().min(0).max(1).optional(),
    lastModified: z.iso.datetime({ offset: true }).optional(),
  })
  .optional();

const meta = z.record(z.string(), z.json()).optional();

const media = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["image", "audio"]), mimeType, data: base64, annotations, _meta: meta }),
  z.object({
    type: z.literal("resource"),
    resource: z.object({
      uri: z.string().min(1),
      mimeType: mimeType.optional(),
      blob: base64,
      _meta: meta,
    }),
    annotations,
    _meta: meta,
  }),
]);

type Media = z.infer<typeof media>;

const bytesOf = (block: Media) =>
  block.type === "resource" ? block.resource.blob.length : block.data.length;

// The whole block, metadata included: only identical blocks share one content block.
const keyOf = (block: Media) => JSON.stringify(block);

// Shallow: the walk below visits each field itself.
const record = z.record(z.string(), z.custom<Json>());

const without = (value: Record<string, Json>, field: string) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));

/** The block as the JSON keeps it: every field except its bytes, plus `contentIndex`. */
const placeholderOf = (value: Record<string, Json>, contentIndex: number): Json => {
  const resource = record.safeParse(value["resource"]);

  if (value["type"] === "resource" && resource.success)
    return { ...value, resource: without(resource.data, "blob"), contentIndex };

  return { ...without(value, "data"), contentIndex };
};

/** A tool result: JSON text, then each media block the JSON refers to by `contentIndex`. */
export type McpResult = { content: [{ type: "text"; text: string }, ...Media[]] };

/**
 * A tool result as JSON text plus each MCP image, audio or blob resource block it holds, at any
 * depth, as its own content block. The JSON keeps the block's other fields and
 * `contentIndex`, the block's index in `content`, so images and files reach the client as media
 * instead of base64 text, once even when the result repeats them. Text resources are readable as
 * JSON and stay in it.
 */
export const mcpResult = (value: Json): McpResult => {
  const blocks: Media[] = [];
  const indexes = new Map<string, number>();
  let mediaBytes = 0;

  const lift = (field: Json): Json => {
    if (Array.isArray(field)) return field.map(lift);
    const object = record.safeParse(field);

    if (!object.success) return field;
    const block = media.safeParse(object.data);

    if (!block.success)
      return Object.fromEntries(
        Object.entries(object.data).map(([key, item]) => [key, lift(item)]),
      );
    const key = keyOf(block.data);
    let contentIndex = indexes.get(key);

    if (contentIndex === undefined) {
      mediaBytes += bytesOf(block.data);

      if (mediaBytes > mcpResultLimits.media)
        throw new Error("MCP media exceeds 5 MiB; return fewer or smaller files");
      blocks.push(block.data);
      contentIndex = blocks.length;
      indexes.set(key, contentIndex);
    }

    return placeholderOf(object.data, contentIndex);
  };

  const text = JSON.stringify(lift(value));

  if (new TextEncoder().encode(text).byteLength > mcpResultLimits.json)
    throw new Error("MCP result exceeds 1 MiB; request a smaller page");

  return { content: [{ type: "text", text }, ...blocks] };
};
