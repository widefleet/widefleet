export interface Search {
  /** Text to match. */
  query: string;
  limit?: number;
}

/** A normal app publishing a search API. */
export default class Reader {
  /**
   * Find matching records.
   * @param input - Search text and optional page size.
   * @example
   * await env.READER.search({ query: "invoice" });
   */
  async search(input: Search): Promise<{ matches: string[] }> {
    return { matches: [input.query] };
  }

  protected internal() {
    return "private";
  }
  static setup() {
    return "setup";
  }
  async fetch() {
    return new Response("connection page");
  }
}
