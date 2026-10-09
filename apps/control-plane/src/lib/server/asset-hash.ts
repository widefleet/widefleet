import { hash } from "blake3-wasm";
import { posix } from "node:path";

// Wrangler hashes base64-encoded bytes followed by the case-sensitive extension.
// Reference: cloudflare/workers-sdk f025bbfddcdab0193bffffc9fe5a9bf143f2fa65,
// packages/deploy-helpers/src/deploy/helpers/hash.ts.
export const hashAsset = (path: string, bytes: Uint8Array) =>
  hash(Buffer.from(bytes).toString("base64") + posix.extname(path).slice(1))
    .toString("hex")
    .slice(0, 32);
