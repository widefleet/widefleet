// Shared by the generated templates: the template generator copies this file into
// each template's src. Edit it in packages/template-generator/src/runtime.
import { z } from "zod";
import type { JsonValue } from "./selection.ts";

/** A selection or input that does not match the API's description. */
export class InvalidRequest extends Error {}

/** JSON as typed inputs and selections hold it, where optional fields may be undefined. */
export type JsonInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonInput[]
  | { readonly [key: string]: JsonInput };

/** A method's arguments by name, as its generated signature types them. */
export type Arguments = Readonly<Record<string, JsonInput>>;

/** The fields to return, as `Selection` types them. */
export type FieldSelection = Readonly<Record<string, JsonInput>>;

// JSON values, leaving out undefined object fields at every depth as JSON does.
// Numbers must be finite: NaN or Infinity never turn into null.
export const definedJson: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(definedJson),
    z
      .record(z.string(), definedJson.optional())
      .transform((entries) =>
        Object.fromEntries(
          Object.entries(entries).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, value] as const],
          ),
        ),
      ),
  ]),
);
