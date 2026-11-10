import { z } from "zod";

const body = z.object({
  size: z.number().int().nonnegative(),
  data: z.string().optional(),
  attachmentId: z.string().optional(),
});

const part = z.object({
  partId: z.string(),
  mimeType: z.string(),
  filename: z.string().default(""),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  body,
  get parts() {
    return z.array(part).optional();
  },
});

export const message = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string(),
  internalDate: z.string(),
  payload: part,
});

export const messagePage = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

export const searchInput = z.object({
  query: z.string().max(4096).default(""),
  maxResults: z.number().int().min(1).max(100).default(20),
  pageToken: z.string().min(1).max(8192).optional(),
});

export const messageId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(256);

export const attachmentId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(4096);

export const attachment = body;

export const messageSearch = (input: z.input<typeof searchInput>) => {
  const options = searchInput.parse(input);
  const query = new URLSearchParams({ maxResults: String(options.maxResults) });

  if (options.query) query.set("q", options.query);

  if (options.pageToken) query.set("pageToken", options.pageToken);

  return `messages?${query.toString()}`;
};

export const decodeBody = (data: string) =>
  Uint8Array.from(atob(data.replaceAll("-", "+").replaceAll("_", "/")), (byte) =>
    byte.charCodeAt(0),
  );

const isTextBody = (value: z.infer<typeof part>) =>
  !value.filename &&
  ["text/plain", "text/html"].includes(value.mimeType) &&
  !value.headers.some(
    (header) =>
      header.name.toLowerCase() === "content-disposition" && /^attachment\b/i.test(header.value),
  );

export const textBodies = (value: z.infer<typeof message>) => {
  const pending = [value.payload];
  const bodies: z.infer<typeof part>[] = [];

  while (pending.length) {
    const current = pending.shift();

    if (!current) break;

    if (isTextBody(current)) bodies.push(current);
    pending.unshift(...(current.parts ?? []));
  }

  return bodies;
};

// MIME parts may be nested (mixed -> alternative -> related). Preserve HTML as
// data for callers; displaying it requires the consuming app's own rendering policy.
export const readMessage = (value: z.infer<typeof message>) => {
  const pending = [value.payload];
  const text: string[] = [];
  const html: string[] = [];

  const attachments: {
    partId: string;
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string | undefined;
    data: Uint8Array | undefined;
  }[] = [];

  while (pending.length) {
    const current = pending.shift();

    if (!current) break;
    pending.unshift(...(current.parts ?? []));
    const bytes = current.body.data === undefined ? undefined : decodeBody(current.body.data);

    if (!isTextBody(current) && (current.filename || bytes || current.body.attachmentId)) {
      attachments.push({
        partId: current.partId,
        filename: current.filename,
        mimeType: current.mimeType,
        size: current.body.size,
        attachmentId: current.body.attachmentId,
        data: bytes,
      });
    } else if (bytes) {
      const contentType = current.headers.find(
        (header) => header.name.toLowerCase() === "content-type",
      )?.value;

      const charset = /;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
      const decoded = new TextDecoder(charset?.[1] ?? charset?.[2] ?? "utf-8").decode(bytes);

      if (current.mimeType === "text/plain") text.push(decoded);

      if (current.mimeType === "text/html") html.push(decoded);
    }
  }

  return {
    id: value.id,
    threadId: value.threadId,
    labelIds: value.labelIds,
    snippet: value.snippet,
    internalDate: value.internalDate,
    headers: value.payload.headers,
    text: text.join("\n"),
    html: html.join("\n"),
    attachments,
  };
};
