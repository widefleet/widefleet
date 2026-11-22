import { describe, expect, it } from "vitest";
import { methodTerms, rankMethods, type SearchableMethod } from "./mcp-search.ts";

const methods = (
  hostname: string,
  summary: string,
  entries: { name: string; summary?: string; parameter?: string }[],
  remarks = "",
): SearchableMethod[] => {
  const entrypoint = {
    name: "default",
    summary,
    remarks,
    examples: [],
    http: false,
    methods: entries.map((entry) => ({
      name: entry.name,
      summary: entry.summary ?? "",
      remarks: "",
      examples: [],
      throws: [],
      signatures: [
        {
          parameters: entry.parameter
            ? [
                {
                  name: entry.parameter,
                  type: "string",
                  description: "",
                  optional: false,
                  rest: false,
                },
              ]
            : [],
          returns: { type: "unknown", description: "" },
        },
      ],
    })),
  };

  return entrypoint.methods.map((method) => ({
    appId: crypto.randomUUID(),
    hostname,
    entrypoint: "default",
    method: method.name,
    summary: method.summary,
    terms: methodTerms(hostname, entrypoint, method),
  }));
};

const catalog = [
  ...Array.from({ length: 40 }, (_, index) =>
    methods(`app-${String(index).padStart(2, "0")}-example.apps.example.test`, "Internal tool", [
      { name: "status" },
    ]),
  ).flat(),
  ...methods("bing-webmaster-example.apps.example.test", "Read Bing Webmaster site statistics", [
    { name: "queryStats", summary: "Search query statistics for a site", parameter: "siteUrl" },
  ]),
  ...methods("google-search-console-example.apps.example.test", "Read Google Search Console data", [
    { name: "searchAnalytics", summary: "Query search analytics", parameter: "siteUrl" },
    { name: "listSites", summary: "List verified sites" },
  ]),
];

const search = (query: string, filter: { hostname?: string; entrypoint?: string } = {}) =>
  rankMethods(catalog, { query, limit: 10, offset: 0, ...filter });

const names = (result: ReturnType<typeof search>) =>
  result.methods.map((entry) => `${entry.hostname.split("-example")[0]}.${entry.method}`);

describe("MCP method search", () => {
  it("returns a distinctive word's match on the first page of a large catalog", () => {
    for (const query of ["analytics", "Analytics", "ANALYTICS"])
      expect(search(query)).toMatchObject({
        methods: [{ method: "searchAnalytics" }],
        remaining: 0,
        next: null,
      });
  });

  it("matches words of the service and its methods independently of their order", () => {
    expect(names(search("Google Search Console site search analytics"))[0]).toBe(
      "google-search-console.searchAnalytics",
    );
  });

  it("matches split identifiers, plurals and parameter names", () => {
    expect(names(search("search analytic"))[0]).toBe("google-search-console.searchAnalytics");
    expect(names(search("site url"))).toEqual([
      "bing-webmaster.queryStats",
      "google-search-console.searchAnalytics",
      "google-search-console.listSites",
    ]);
    expect(names(search("webmasters"))).toEqual(["bing-webmaster.queryStats"]);
  });

  it("returns nothing for unmatched words", () => {
    expect(search("inventory")).toEqual({ methods: [], remaining: 0, next: null });
  });

  it("lists every method of one service, or narrows a query to it", () => {
    const hostname = "google-search-console-example.apps.example.test";
    expect(names(search("", { hostname, entrypoint: "default" }))).toEqual([
      "google-search-console.listSites",
      "google-search-console.searchAnalytics",
    ]);
    expect(names(search("site", { hostname }))).toEqual([
      "google-search-console.listSites",
      "google-search-console.searchAnalytics",
    ]);
    expect(search("", { hostname, entrypoint: "Reader" }).methods).toEqual([]);
  });

  it("keeps method and parameter names searchable beside long entrypoint prose", () => {
    const documented = methods(
      "stock-example.apps.example.test",
      "Stock movements are reconciled nightly. ".repeat(600),
      [{ name: "readInventory", parameter: "warehouseId" }],
    );

    for (const query of ["readInventory", "warehouseId"])
      expect(
        rankMethods([...catalog, ...documented], { query, limit: 10, offset: 0 }).methods[0],
      ).toEqual(documented[0]);
  });

  it("pages through every method with the returned next input", () => {
    const seen: string[] = [];
    let request: Parameters<typeof rankMethods>[1] | null = { query: "", limit: 15, offset: 0 };

    while (request) {
      const page = rankMethods(catalog, request);
      seen.push(...page.methods.map((entry) => `${entry.hostname}/${entry.method}`));
      expect(page.remaining).toBe(catalog.length - seen.length);
      request = page.next;
    }

    expect(seen).toHaveLength(catalog.length);
    expect(new Set(seen).size).toBe(catalog.length);
    expect(seen).toEqual(seen.toSorted());
  });
});
