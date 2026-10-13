import { expect, it } from "vitest";
import { hashAsset } from "../src/lib/server/asset-hash.ts";

// Recorded with the previous blake3-wasm implementation of Wrangler's asset hash.
it.each([
  { path: "/LICENSE", bytes: new Uint8Array(), expected: "af1349b9f5f9a1a6a0404dea36dcc949" },
  {
    path: "/index.html",
    bytes: Buffer.from("hello"),
    expected: "a2b82584e50075886b08927390f2f573",
  },
  {
    path: "/index.HTML",
    bytes: Buffer.from("hello"),
    expected: "2b5206f6e76c70802411b8eaea82dad6",
  },
  {
    path: "/data.bin",
    bytes: Uint8Array.from({ length: 256 }, (_, index) => index),
    expected: "04c51b7bb2984817f8bb7099dde4021f",
  },
  {
    path: "/large.bin",
    bytes: Uint8Array.from({ length: 65_537 }, (_, index) => index % 251),
    expected: "30c89bf818158355e994444247d766a7",
  },
])("preserves the asset hash for $path", ({ path, bytes, expected }) => {
  expect(hashAsset(path, bytes)).toBe(expected);
});
