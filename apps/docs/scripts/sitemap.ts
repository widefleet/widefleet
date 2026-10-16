import { XMLParser, XMLValidator } from "fast-xml-parser";

export function parseSitemap(xml: string) {
  if (xml.includes("<!DOCTYPE") || XMLValidator.validate(xml) !== true) {
    throw new Error("Expected a well-formed sitemap without a DOCTYPE declaration.");
  }

  const entries: Map<string, string>[] = [];
  let foundRoot = false;

  // Read the two sitemap fields through typed callbacks; ignore other metadata.
  const parser = new XMLParser({
    ignoreDeclaration: true,
    ignorePiTags: true,
    removeNSPrefix: true,
    parseTagValue: false,
    updateTag(tag, fullPath) {
      const path = String(fullPath).replace(/(^|\.)[^.:]+:/g, "$1");

      if (path === tag) {
        if (tag !== "urlset" || foundRoot) throw new Error("Expected one sitemap urlset.");
        foundRoot = true;
      } else if (path === "urlset.url") {
        entries.push(new Map());
      } else if (path === "urlset.url.loc" || path === "urlset.url.lastmod") {
        const entry = entries.at(-1);

        if (!entry || entry.has(tag)) throw new Error(`Duplicate or misplaced ${tag}.`);
        entry.set(tag, "");
      } else if (
        path.startsWith("urlset.url.loc.") ||
        path.startsWith("urlset.url.lastmod.") ||
        path.split(".").length === 2
      ) {
        throw new Error("Unexpected sitemap structure.");
      }

      return tag;
    },
    tagValueProcessor(tag, value, fullPath) {
      const path = String(fullPath).replace(/(^|\.)[^.:]+:/g, "$1");

      if ((path === "urlset" || path === "urlset.url") && value.trim()) {
        throw new Error("Unexpected text in sitemap structure.");
      }

      if (path === "urlset.url.loc" || path === "urlset.url.lastmod") {
        const entry = entries.at(-1);

        if (!entry) throw new Error(`Misplaced ${tag}.`);
        entry.set(tag, (entry.get(tag) ?? "") + value);
      }

      return value;
    },
  });

  parser.parse(xml);

  if (!foundRoot) throw new Error("Expected a sitemap urlset.");

  const pages = new Map<string, string>();

  for (const entry of entries) {
    const location = entry.get("loc");
    const lastmod = entry.get("lastmod");

    if (!location || !lastmod) throw new Error("Every sitemap URL needs loc and lastmod.");

    if (pages.has(location)) throw new Error(`Duplicate sitemap URL: ${location}`);

    const date = lastmod.slice(0, 10);
    const timestamp = Date.parse(lastmod);

    if (
      !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(lastmod) ||
      !Number.isFinite(timestamp) ||
      new Date(date).toISOString().slice(0, 10) !== date
    ) {
      throw new Error(`Invalid lastmod for ${location}.`);
    }

    pages.set(location, lastmod);
  }

  return pages;
}
