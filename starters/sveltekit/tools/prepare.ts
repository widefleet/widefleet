import { rm } from "node:fs/promises";

// The adapter already separates its worker from public files. This extra file
// describes Wrangler's upload exclusions; celld does not interpret it.
await rm(new URL("../build/public/.assetsignore", import.meta.url), { force: true });
