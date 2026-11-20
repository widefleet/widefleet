/** A search request. */
interface Query {
  /** Text to search for. */
  text: string;
  /** Maximum number of matches. */
  limit?: number;
}
