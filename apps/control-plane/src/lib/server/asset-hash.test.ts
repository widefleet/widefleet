import { expect, it } from "vitest";
import { hashAsset } from "./asset-hash.ts";

it("matches the BLAKE3 empty-input vector used for an empty extensionless asset", () => {
  expect(hashAsset("/LICENSE", new Uint8Array())).toBe("af1349b9f5f9a1a6a0404dea36dcc949");
});

it("deduplicates equal content and extension while preserving MIME distinctions", () => {
  const bytes = new TextEncoder().encode("hello");
  expect(hashAsset("/one/file.txt", bytes)).toBe(hashAsset("/two/renamed.txt", bytes));
  expect(hashAsset("/file.txt", bytes)).not.toBe(hashAsset("/file.html", bytes));
  expect(hashAsset("/file.txt", bytes)).not.toBe(hashAsset("/file.TXT", bytes));
  expect(hashAsset("/file.txt", bytes)).not.toBe(hashAsset("/file.txt", new Uint8Array()));
});
