import { z } from "zod";

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

/** A description's JSON, as parsed from its JSON or YAML text. */
export const json = z.json();

export type Json = z.infer<typeof json>;

/** A JSON object of a description, such as a schema. */
export const jsonObject = z.record(z.string(), json);

export type JsonObject = z.infer<typeof jsonObject>;

/**
 * The entries of a JSON object, or null for other values. It looks one level
 * deep, so walking a large description stays linear.
 */
export const jsonEntries = (value: Json) =>
  value instanceof Object && !Array.isArray(value) ? Object.entries(value) : null;
