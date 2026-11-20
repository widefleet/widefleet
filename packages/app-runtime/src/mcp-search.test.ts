import { describe, expect, it } from "vitest";
import { rankServices, serviceTerms, type SearchableService } from "./mcp-search.ts";

const service = (
  hostname: string,
  summary = "",
  methods: { name: string; summary?: string; parameter?: string }[] = [],
): SearchableService => ({
  appId: crypto.randomUUID(),
  hostname,
  entrypoint: "default",
  summary,
  terms: serviceTerms(hostname, "default", {
    name: "default",
    summary,
    remarks: "",
    examples: [],
    http: false,
    methods: methods.map((method) => ({
      name: method.name,
      summary: method.summary ?? "",
      remarks: "",
      examples: [],
      throws: [],
      signatures: [
        {
          parameters: method.parameter
            ? [
                {
                  name: method.parameter,
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
  }),
});

const catalog = [
  ...Array.from({ length: 40 }, (_, index) =>
    service(`app-${String(index).padStart(2, "0")}-example.apps.example.test`, "Internal tool"),
  ),
  service("bing-webmaster-example.apps.example.test", "Read Bing Webmaster site statistics", [
    { name: "queryStats", summary: "Search query statistics for a site", parameter: "siteUrl" },
  ]),
  service("google-search-console-example.apps.example.test", "Read Google Search Console data", [
    { name: "searchAnalytics", summary: "Query search analytics", parameter: "siteUrl" },
  ]),
];

const search = (query: string, limit = 10, offset = 0) =>
  rankServices(catalog, { query, limit, offset });

const hostnames = (result: ReturnType<typeof search>) =>
  result.services.map((entry) => entry.hostname.split("-example")[0]);

describe("MCP service search", () => {
  it("returns a distinctive word's match on the first page of a large catalog", () => {
    for (const query of ["console", "Google", "CONSOLE"])
      expect(search(query)).toMatchObject({
        services: [{ hostname: "google-search-console-example.apps.example.test" }],
        remaining: 0,
        next: null,
      });
  });

  it("matches words independently of their order and adjacency", () => {
    const result = search("Google Search Console site search analytics");

    expect(hostnames(result)).toEqual(["google-search-console", "bing-webmaster"]);
  });

  it("matches split identifiers, plurals and parameter names", () => {
    expect(hostnames(search("search analytic"))[0]).toBe("google-search-console");
    expect(hostnames(search("site url"))).toEqual(["bing-webmaster", "google-search-console"]);
    expect(hostnames(search("webmasters"))).toEqual(["bing-webmaster"]);
  });

  it("returns nothing for unmatched words", () => {
    expect(search("inventory")).toEqual({ services: [], remaining: 0, next: null });
  });

  it("lists an exact hostname alone", () => {
    expect(hostnames(search("Bing-Webmaster-Example.apps.example.test "))).toEqual([
      "bing-webmaster",
    ]);
  });

  it("keeps method and parameter names searchable beside long remarks", () => {
    const hostname = "stock-example.apps.example.test";

    const documented: SearchableService = {
      appId: crypto.randomUUID(),
      hostname,
      entrypoint: "Stock",
      summary: "Stock operations",
      terms: serviceTerms(hostname, "Stock", {
        name: "Stock",
        summary: "Stock operations",
        remarks: "Stock movements are reconciled nightly. ".repeat(600),
        examples: [],
        http: false,
        methods: [
          {
            name: "readInventory",
            summary: "",
            remarks: "",
            examples: [],
            throws: [],
            signatures: [
              {
                parameters: [
                  {
                    name: "warehouseId",
                    type: "string",
                    description: "",
                    optional: false,
                    rest: false,
                  },
                ],
                returns: { type: "unknown", description: "" },
              },
            ],
          },
        ],
      }),
    };

    for (const query of ["readInventory", "warehouseId"])
      expect(
        rankServices([...catalog, documented], { query, limit: 10, offset: 0 }).services,
      ).toContainEqual(documented);
  });

  it("pages through every service with the returned next input", () => {
    const seen: string[] = [];
    let request: Parameters<typeof rankServices>[1] | null = { query: "", limit: 15, offset: 0 };

    while (request) {
      const page = rankServices(catalog, request);
      seen.push(...page.services.map((entry) => entry.hostname));
      expect(page.remaining).toBe(catalog.length - seen.length);
      request = page.next;
    }

    expect(seen).toHaveLength(catalog.length);
    expect(new Set(seen).size).toBe(catalog.length);
    expect(seen).toEqual(seen.toSorted());
  });
});
