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

// Keywords whose values are data, such as an example, rather than description.
const literalKeys = new Set(["example", "examples", "default", "enum", "const"]);

// Maps whose keys are names, where `default` or `example` names a schema, a
// property or an answer rather than data.
const nameMaps = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "schemas",
  "parameters",
  "responses",
  "requestBodies",
  "paths",
]);

/** Whether the object under `key` maps names to values, such as a schema's properties. */
export const holdsNames = (key: string) => nameMaps.has(key);

/**
 * Whether the value under `key` is literal data, such as an example or an
 * extension, whose `$ref` fields are data rather than references. `parent` is
 * the key of the object that holds it.
 */
export const literalData = (key: string, parent: string | null) =>
  !(parent !== null && nameMaps.has(parent)) && (literalKeys.has(key) || key.startsWith("x-"));
