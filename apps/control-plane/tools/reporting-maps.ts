import { mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

// Keep our browser maps in the server image, outside the publicly served client tree.
const root = "build/client";

for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.map(?:\.(?:gz|br))?$/.test(entry.name)) continue;
  const source = join(entry.parentPath, entry.name);

  const target = join("build/reporting-maps", relative(root, source));
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}
