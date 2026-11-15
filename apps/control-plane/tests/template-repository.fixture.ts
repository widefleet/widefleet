import { readFile, readdir } from "node:fs/promises";

const root = new URL("../../../templates/", import.meta.url);

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

  if (url.origin !== "https://raw.githubusercontent.com") return null;

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
