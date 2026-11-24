import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { z } from "zod";

const directory = new URL("../migrations/", import.meta.url);

describe("Migration journal", () => {
  // Drizzle applies only the migrations that the journal lists.
  it("registers every migration file in the journal that installations apply", async () => {
    const journal = z
      .object({ entries: z.array(z.object({ tag: z.string() })) })
      .parse(JSON.parse(await readFile(new URL("meta/_journal.json", directory), "utf8")));

    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .map((file) => file.slice(0, -".sql".length))
      .sort();

    expect(journal.entries.map((entry) => entry.tag)).toEqual(files);
  });
});
