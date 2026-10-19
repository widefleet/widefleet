import * as contract from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseWorkerUpload } from "../src/lib/server/upload-body.ts";
import {
  connectorFixture,
  connectorUploadForm,
  connectorSource,
} from "./cloudflare-connector.fixture.ts";

describe.each(["app", "connector"])("Shared %s multipart upload", (kind) => {
  const read = (request: Request) =>
    kind === "app"
      ? parseWorkerUpload(request, contract.workerMetadata)
      : parseWorkerUpload(request, contract.connectorUploadMetadata);

  const form = () => {
    const value = connectorUploadForm(connectorFixture());

    if (kind === "app")
      value.set(
        "metadata",
        JSON.stringify({
          main_module: "connector.js",
          compatibility_date: "2026-10-01",
          assets: { upload_session: crypto.randomUUID() },
        }),
      );

    return value;
  };

  const request = (body: FormData) =>
    new Request("https://fixture.test/upload", { method: "PUT", body });

  it("accepts metadata as JSON text or a JSON file, with unchanged module bytes", async () => {
    const body = form();
    const text = (await read(request(body))).unwrap();
    body.set(
      "metadata",
      new Blob([z.string().parse(body.get("metadata"))], { type: "application/json" }),
      "metadata.json",
    );
    const file = (await read(request(body))).unwrap();
    expect(file).toEqual(text);
    expect(file.modules).toEqual([expect.objectContaining({ name: "connector.js", type: "esm" })]);
    expect(new TextDecoder().decode(file.modules[0]?.bytes)).toBe(connectorSource);
  });

  it("rejects JSON bodies, repeated or oversized metadata and non-file modules", async () => {
    expect(
      (
        await read(
          new Request("https://fixture.test/upload", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(connectorFixture()),
          }),
        )
      ).isErr(),
    ).toBe(true);
    const duplicate = form();
    duplicate.append("metadata", z.string().parse(duplicate.get("metadata")));
    expect((await read(request(duplicate))).isErr()).toBe(true);
    const oversized = form();
    // Valid leading JSON whitespace is still part of the metadata byte limit.
    oversized.set("metadata", " ".repeat(64 * 1024) + z.string().parse(oversized.get("metadata")));
    expect((await read(request(oversized))).isErr()).toBe(true);
    const string = form();
    string.set("connector.js", "export default {}");
    expect((await read(request(string))).isErr()).toBe(true);
    const largeFile = form();
    largeFile.set(
      "connector.js",
      new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: "application/javascript+module" }),
      "connector.js",
    );
    expect((await read(request(largeFile))).isErr()).toBe(true);
  });
});
