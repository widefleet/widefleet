import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const source = new URL("../dist/", import.meta.url);

const target = new URL("../.wrangler/docs-assets/", import.meta.url);

// These origin-level resources belong to the docs deployment. Keep the list
// explicit so other /.well-known endpoints remain owned by the website.
const discoveryPaths = [
  "/SKILL.md",
  "/.well-known/agent-skills/index.json",
  "/.well-known/ai-catalog.json",
  "/.well-known/ard.json",
  "/.well-known/api-catalog",
];

// Astro's base changes URLs, not the output directory. Mount the entire build
// under /docs so the asset Worker accepts the original public request unchanged.
await rm(target, { recursive: true, force: true });

await mkdir(target, { recursive: true });

await cp(source, new URL("docs/", target), { recursive: true });

// Cloudflare reads response rules at the asset root. Blume already prefixes
// their route patterns and discovery links with the deployment base.
const headers = await readFile(new URL("_headers", source), "utf8");

const rules = new Map<string, string[]>();

// Blume emits repeated blocks for some paths. Cloudflare keeps only the last
// block, so merge them to retain both Content-Type and CORS/security headers.
for (const block of headers.trim().split(/\n(?=\/)/u)) {
  const [path, ...values] = block.split("\n");

  if (!path) continue;
  const route = path === "/docs/" ? "/docs" : path;
  rules.set(route, [...(rules.get(route) ?? []), ...values]);
}

// Asset rewrites preserve the requested URL, so headers must also match the
// root alias. Reuse the generated discovery headers, including repeated blocks.
for (const path of discoveryPaths) {
  const values = rules.get(`/docs${path}`);

  if (values) rules.set(path, values);
}

rules.set("/SKILL.md", ["  Content-Type: text/markdown; charset=utf-8"]);

// Status 200 serves the existing generated file without redirecting the reader
// or copying its content into a second artifact.
await writeFile(
  new URL("_redirects", target),
  `${discoveryPaths.map((path) => `${path} /docs${path} 200`).join("\n")}\n`,
);

// Custom-domain Previews need an explicit noindex rule scoped to their hostnames.
rules.set("https://:preview.docs.widefleet.com/*", ["  X-Robots-Tag: noindex"]);

await writeFile(
  new URL("_headers", target),
  `${[...rules].map(([path, values]) => [path, ...values].join("\n")).join("\n")}\n`,
);

await rm(new URL("docs/_headers", target));

await cp(new URL("404.html", source), new URL("404.html", target));
