import * as contract from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseWorkerUpload } from "../src/lib/server/upload-body.ts";

const source = "export default { fetch() { return new Response('fixture'); } };";

const metadata = () => ({
  main_module: "worker.js",
  compatibility_date: "2026-10-01",
  assets: { upload_session: crypto.randomUUID() },
});

describe("App multipart upload", () => {
  const read = (request: Request) => parseWorkerUpload(request, contract.workerMetadata);

  const form = () => {
    const value = new FormData();
    value.set(
      "worker.js",
      new Blob([source], { type: "application/javascript+module" }),
      "worker.js",
    );

    value.set(
      "metadata",
      JSON.stringify({
        main_module: "worker.js",
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
    expect(file.modules).toEqual([expect.objectContaining({ name: "worker.js", type: "esm" })]);
    expect(new TextDecoder().decode(file.modules[0]?.bytes)).toBe(source);
  });

  it("rejects JSON bodies, repeated or oversized metadata and non-file modules", async () => {
    expect(
      (
        await read(
          new Request("https://fixture.test/upload", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(metadata()),
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
    string.set("worker.js", "export default {}");
    expect((await read(request(string))).isErr()).toBe(true);
    const largeFile = form();
    largeFile.set(
      "worker.js",
      new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: "application/javascript+module" }),
      "worker.js",
    );
    expect((await read(request(largeFile))).isErr()).toBe(true);
  });
});
