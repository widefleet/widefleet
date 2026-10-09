import { z } from "zod";

export const directoryGroup = z.strictObject({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(512),
  description: z.string().max(4096).nullable(),
  source: z.string().min(1).max(100),
});

export const groupSearch = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(
      (value) =>
        Array.from(value).every(
          (character) =>
            character.charCodeAt(0) >= 32 &&
            character.charCodeAt(0) !== 127 &&
            !['"', "\\"].includes(character),
        ),
      "Use a group name without control characters, quotes or backslashes",
    ),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const groupSearchResult = z.strictObject({
  groups: z.array(directoryGroup),
  hasMore: z.boolean(),
});
