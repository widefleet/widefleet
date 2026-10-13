import { mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

// Keep our browser maps in the server image, outside the publicly served client tree.
const destination = process.argv[2] === "cloudflare" ? "dist/cloudflare" : "build";

const root = process.argv[2] === "cloudflare" ? `${destination}/public` : `${destination}/client`;

for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.map(?:\.(?:gz|br))?$/.test(entry.name)) continue;
  const source = join(entry.parentPath, entry.name);

  const target = join(destination, "reporting-maps", relative(root, source));
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}
