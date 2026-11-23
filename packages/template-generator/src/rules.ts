/**
 * The kind of change an operation makes, which decides when it asks the user
 * first: creating data, changing or deleting existing data, or sending
 * something to other people, such as an email.
 */
export type Change = "create" | "update" | "delete" | "send";

/** An operation that is not offered, with the key of the reason in the template's rules. */
export type Hidden = { hidden: string };

/** What a generator writes, by path inside the template. */
export interface GeneratedFiles {
  files: Record<string, string>;
  summary: string;
}
