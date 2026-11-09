import { WorkerEntrypoint } from "cloudflare:workers";
import {
  accountConnection,
  maximumDownloadBytes,
  readBytes,
  type Environment,
  type Properties,
} from "@platform/account-connection";
import { z } from "zod";
import {
  attachment,
  attachmentId,
  decodeBody,
  message,
  messageId,
  messagePage,
  messageSearch,
  readMessage,
  searchInput,
  textBodies,
} from "./messages.ts";
import { provider } from "./provider.ts";

/** Search and read the current user's Gmail. Connect the account on this app's page first. */
export default class Gmail extends WorkerEntrypoint<Environment, Properties> {
  #connection() {
    return accountConnection(this.env, this.ctx.props, provider);
  }

  /** Check account setup and linking. A connected account may still need reauthorization when used. */
  async connectionStatus() {
    return this.#connection().status();
  }

  /**
   * Search messages using Gmail's search syntax. Results contain IDs; use getMessage to read them.
   * @param input - Query, page size (1–100) and the previous result's nextPageToken.
   * @example
   * await env.GMAIL.searchMessages({ query: "has:attachment filename:pdf", maxResults: 10 });
   */
  async searchMessages(input: z.input<typeof searchInput> = {}) {
    const result = await this.#connection().request(
      `https://gmail.googleapis.com/gmail/v1/users/me/${messageSearch(input)}`,
    );

    if (result.status !== "connected") return result;

    return { status: "connected", ...messagePage.parse(await result.response.json()) } as const;
  }

  /** Read headers, plain text, HTML and attachment descriptors. HTML is untrusted email content. */
  async getMessage(id: string) {
    const parsedId = messageId.parse(id);
    const connection = this.#connection();

    const result = await connection.request(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${parsedId}?format=full`,
    );

    if (result.status !== "connected") return result;
    const bytes = await readBytes(result.response);

    if (bytes.status !== "connected") return bytes;
    const value = message.parse(JSON.parse(new TextDecoder().decode(bytes.data)));

    // Gmail can store large text bodies via the attachments endpoint too.
    for (const part of textBodies(value)) {
      if (!part.body.attachmentId || part.body.data !== undefined) continue;
      const body = await this.getAttachment(parsedId, part.body.attachmentId);

      if (body.status !== "connected") return body;
      part.body.data = body.base64url;
    }

    return { status: "connected", message: readMessage(value) } as const;
  }

  /** Download an attachment by message ID and attachmentId, up to 8 MiB. Returns base64url and bytes. */
  async getAttachment(id: string, part: string) {
    const result = await this.#connection().request(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId.parse(id)}/attachments/${attachmentId.parse(part)}`,
    );

    if (result.status !== "connected") return result;

    const bytes = await readBytes(
      result.response,
      Math.ceil((maximumDownloadBytes * 4) / 3) + 4096,
    );

    if (bytes.status !== "connected")
      return { status: "too_large", maximumBytes: maximumDownloadBytes } as const;
    const value = attachment.parse(JSON.parse(new TextDecoder().decode(bytes.data)));

    if (value.size > maximumDownloadBytes)
      return { status: "too_large", maximumBytes: maximumDownloadBytes } as const;
    const base64url = value.data ?? "";
    const data = decodeBody(base64url);

    if (data.byteLength > maximumDownloadBytes)
      return { status: "too_large", maximumBytes: maximumDownloadBytes } as const;

    return { status: "connected", size: data.byteLength, data, base64url } as const;
  }

  override async fetch(request: Request) {
    return this.#connection().fetch(request);
  }
}
