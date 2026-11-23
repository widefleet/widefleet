import { describe, expect, it } from "vitest";
import { mcpResult } from "./mcp-media.ts";

const png = "iVBORw0KGgo=";

const pdf = "JVBERi0xLjQK";

describe("mcpResult", () => {
  it("keeps plain JSON as one text block", () => {
    expect(mcpResult({ contentType: "image/png", base64: png })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ contentType: "image/png", base64: png }) }],
    });
  });

  it("lifts image, audio and blob resource blocks at any depth", () => {
    const result = mcpResult({
      photo: { type: "image", mimeType: "image/png", data: png },
      files: [
        {
          name: "report.pdf",
          file: {
            type: "resource",
            resource: { uri: "file:///report.pdf", mimeType: "application/pdf", blob: pdf },
          },
        },
      ],
      voice: { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
    });

    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({
      photo: { type: "image", mimeType: "image/png", contentIndex: 1 },
      files: [
        {
          name: "report.pdf",
          file: {
            type: "resource",
            resource: { uri: "file:///report.pdf", mimeType: "application/pdf" },
            contentIndex: 2,
          },
        },
      ],
      voice: { type: "audio", mimeType: "audio/wav", contentIndex: 3 },
    });
    expect(result.content.slice(1)).toEqual([
      { type: "image", mimeType: "image/png", data: png },
      {
        type: "resource",
        resource: { uri: "file:///report.pdf", mimeType: "application/pdf", blob: pdf },
      },
      { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
    ]);
  });

  it("keeps other fields in the JSON and MCP metadata on the block", () => {
    const result = mcpResult({
      type: "image",
      mimeType: "image/png",
      data: png,
      caption: "Floor plan",
      annotations: { audience: ["user"], priority: 0.5 },
      _meta: { source: "drive" },
    });

    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({
      type: "image",
      mimeType: "image/png",
      caption: "Floor plan",
      annotations: { audience: ["user"], priority: 0.5 },
      _meta: { source: "drive" },
      contentIndex: 1,
    });
    expect(result.content[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: png,
      annotations: { audience: ["user"], priority: 0.5 },
      _meta: { source: "drive" },
    });

    const file = mcpResult({
      id: "f1",
      type: "resource",
      resource: { uri: "file:///a.pdf", blob: pdf, name: "a.pdf" },
    });

    expect(JSON.parse(file.content[0]?.text ?? "null")).toEqual({
      id: "f1",
      type: "resource",
      resource: { uri: "file:///a.pdf", name: "a.pdf" },
      contentIndex: 1,
    });
    expect(file.content[1]).toEqual({
      type: "resource",
      resource: { uri: "file:///a.pdf", blob: pdf },
    });
  });

  it("sends repeated media once", () => {
    const image = { type: "image", mimeType: "image/png", data: png };
    const result = mcpResult([image, { again: image }]);

    expect(result.content).toHaveLength(2);
    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual([
      { type: "image", mimeType: "image/png", contentIndex: 1 },
      { again: { type: "image", mimeType: "image/png", contentIndex: 1 } },
    ]);
  });

  it("sends the same bytes with different metadata as separate blocks", () => {
    const result = mcpResult([
      { type: "image", mimeType: "image/png", data: png, annotations: { audience: ["user"] } },
      { type: "image", mimeType: "image/png", data: png, annotations: { audience: ["assistant"] } },
    ]);

    expect(result.content.slice(1)).toEqual([
      { type: "image", mimeType: "image/png", data: png, annotations: { audience: ["user"] } },
      { type: "image", mimeType: "image/png", data: png, annotations: { audience: ["assistant"] } },
    ]);
  });

  it("turns base64url and unpadded data into standard base64", () => {
    const result = mcpResult({ type: "image", mimeType: "image/png", data: "-_8\n" });

    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "+/8=" });
  });

  it("keeps text resources and invalid blocks in the JSON", () => {
    const value = {
      csv: { type: "resource", resource: { uri: "file:///codes.csv", text: "a,b\n" } },
      notBase64: { type: "image", mimeType: "image/png", data: "not base64!" },
      noMimeType: { type: "image", data: png },
    };

    expect(mcpResult(value)).toEqual({
      content: [{ type: "text", text: JSON.stringify(value) }],
    });
  });

  it("limits the JSON to 1 MiB and media to 5 MiB", () => {
    expect(() => mcpResult("x".repeat(1024 * 1024))).toThrow("exceeds 1 MiB");

    const data = "A".repeat(3 * 1024 * 1024);

    expect(mcpResult({ type: "image", mimeType: "image/png", data }).content[1]).toMatchObject({
      type: "image",
    });
    expect(() =>
      mcpResult([
        { type: "image", mimeType: "image/png", data },
        { type: "image", mimeType: "image/jpeg", data },
      ]),
    ).toThrow("MCP media exceeds 5 MiB");
  });
});
