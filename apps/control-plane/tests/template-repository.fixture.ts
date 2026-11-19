import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../../../templates/", import.meta.url);

/** The commit the synthetic repository serves templates at. */
export const templateCommit = "0123456789abcdef0123456789abcdef01234567";

// Serve repository files locally so catalog tests never depend on GitHub or a published branch.
export const templateRepository = async (url: URL) => {
  if (url.href === "https://api.github.com/repos/widefleet/widefleet/contents/templates?ref=main") {
    const entries = await readdir(root, { withFileTypes: true });

    return Response.json(
      entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
      })),
    );
  }

  if (url.href === "https://api.github.com/repos/widefleet/widefleet/commits/main")
    return Response.json({ sha: templateCommit });

  if (
    url.href ===
    `https://api.github.com/repos/widefleet/widefleet/git/trees/${templateCommit}?recursive=1`
  ) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });

    return Response.json({
      truncated: false,
      tree: entries.flatMap((entry) => {
        const path = relative(fileURLToPath(root), join(entry.parentPath, entry.name));

        return path.split(sep).includes("node_modules")
          ? []
          : [
              {
                path: `templates/${path.split(sep).join("/")}`,
                type: entry.isDirectory() ? "tree" : "blob",
              },
            ];
      }),
    });
  }

  if (url.origin !== "https://raw.githubusercontent.com") return null;

  const pinned = new RegExp(`^/widefleet/widefleet/${templateCommit}/templates/(.+)$`, "u").exec(
    url.pathname,
  );

  if (pinned?.[1]) return new Response(await readFile(new URL(pinned[1], root), "utf8"));

  const match = /^\/widefleet\/widefleet\/main\/templates\/([a-z][a-z0-9-]*)\/template\.md$/u.exec(
    url.pathname,
  );

  if (!match?.[1]) throw new Error(`Unexpected repository request: ${url.href}`);

  try {
    return new Response(await readFile(new URL(`${match[1]}/template.md`, root), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return new Response(null, { status: 404 });
    throw error;
  }
};
