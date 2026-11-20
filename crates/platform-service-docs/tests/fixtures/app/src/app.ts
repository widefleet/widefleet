import { label } from "./label.ts";

const handler = {
  /**
   * Greet a person.
   * @param name Who to greet.
   * @returns The greeting.
   */
  async greet(name: string): Promise<string> {
    return label(name);
  },

  /** Find entries that match a query. */
  async find(query: Query) {
    return { matches: [query.text].slice(0, query.limit ?? 1) };
  },
};

export default handler satisfies object;
