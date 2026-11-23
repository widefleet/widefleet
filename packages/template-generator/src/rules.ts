/** The kind of change a mutation makes, which decides when it asks the user first. */
export type Change = "create" | "update" | "delete";

/** An operation that is not offered, with the key of the reason in the template's rules. */
export type Hidden = { hidden: string };

/** What a generator writes, by path inside the template. */
export interface GeneratedFiles {
  files: Record<string, string>;
  summary: string;
}
