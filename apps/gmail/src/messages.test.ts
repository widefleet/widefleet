import { describe, expect, it } from "vitest";
import { message, messageSearch, readMessage } from "./messages.ts";

describe("Gmail messages", () => {
  it("forwards search and pagination without treating search text as URL parameters", () => {
    const url = new URL(
      messageSearch({ query: "from:alice@example.test &subject:invoice", pageToken: "a+b/c" }),
      "https://gmail.googleapis.com/",
    );

    expect(url.searchParams.get("q")).toBe("from:alice@example.test &subject:invoice");
    expect(url.searchParams.get("pageToken")).toBe("a+b/c");
    expect(url.searchParams.get("subject")).toBeNull();
  });

  it("reads nested alternative content and both inline and separately fetched attachments", () => {
    const parsed = message.parse({
      id: "m1",
      threadId: "t1",
      snippet: "Invoice",
      internalDate: "1700000000000",
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        filename: "",
        headers: [{ name: "Subject", value: "Invoice" }],
        body: { size: 0 },
        parts: [
          {
            partId: "0",
            mimeType: "multipart/alternative",
            filename: "",
            headers: [],
            body: { size: 0 },
            parts: [
              {
                partId: "0.0",
                mimeType: "text/plain",
                filename: "",
                headers: [],
                body: { size: 5, data: "SGVsbG8" },
              },
              {
                partId: "0.1",
                mimeType: "text/html",
                filename: "",
                headers: [],
                body: { size: 12, data: "PHA-SGVsbG88L3A-" },
              },
            ],
          },
          {
            partId: "1",
            mimeType: "application/pdf",
            filename: "invoice.pdf",
            headers: [],
            body: { size: 1000, attachmentId: "attachment" },
          },
          {
            partId: "2",
            mimeType: "text/plain",
            filename: "note.txt",
            headers: [],
            body: { size: 4, data: "Tm90ZQ" },
          },
        ],
      },
    });

    const result = readMessage(parsed);
    expect(result.text).toBe("Hello");
    expect(result.html).toBe("<p>Hello</p>");
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]?.attachmentId).toBe("attachment");
    expect(new TextDecoder().decode(result.attachments[1]?.data)).toBe("Note");
  });
});
