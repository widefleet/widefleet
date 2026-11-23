// Shared by the generated templates that read or send file content: the
// template generator copies this file into each template's src. Edit it in
// packages/template-generator/src/runtime.
import { boundedBody, maximumResponseBytes } from "./input.ts";

/**
 * File content: where to download it, when the API answers with a temporary
 * download address, or the content itself: text for text media types, such as
 * `text/csv` or JSON, and base64 for others. Results reach apps and MCP clients
 * as JSON, which carries no bytes.
 */
export type BinaryContent =
  | { downloadUrl: string }
  | { contentType: string; text: string }
  | { contentType: string; base64: string };

/**
 * File content to upload, with its media type: text, sent as UTF-8, or bytes as
 * base64, such as text in another charset.
 */
export type UploadContent =
  | { mimeType: string; text: string }
  | { mimeType: string; base64: string };

// Spreading a whole file into fromCharCode would exceed the argument limit.
const chunkBytes = 0x8000;

const base64Of = (bytes: Uint8Array) => {
  let binary = "";

  for (let start = 0; start < bytes.length; start += chunkBytes)
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkBytes));

  return btoa(binary);
};

// Text media types: `text/*`, JSON and XML, with RFC 6839's structured
// suffixes such as `application/ld+json`.
const textMedia = /^(?:text\/[^;]+|application\/(?:[^;]+\+)?(?:json|xml))\s*(?:;|$)/i;

/**
 * Content of a text media type in its charset, UTF-8 when the type names none.
 * Content that is not valid text in that charset, or a charset the runtime does
 * not know, stays bytes.
 */
const textOf = (contentType: string, data: Uint8Array) => {
  if (!textMedia.test(contentType)) return null;
  const charset = /;\s*charset="?([^";]+)"?/i.exec(contentType)?.[1] ?? "utf-8";

  try {
    return new TextDecoder(charset, { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    return null;
  }
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

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const text = textOf(contentType, data);

  return text === null ? { contentType, base64: base64Of(data) } : { contentType, text };
};
