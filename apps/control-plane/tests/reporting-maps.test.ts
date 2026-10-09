import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createReportingSymbolicator } from "../src/lib/server/reporting-maps.ts";

it("resolves only Widefleet locations without exporting source content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-reporting-maps-"));

  try {
    const maps = join(directory, "reporting-maps/_app/immutable/chunks");
    await mkdir(maps, { recursive: true });
    await writeFile(
      join(maps, "synthetic.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["../../../src/routes/settings/+page.svelte"],
        names: [],
        mappings: "AAAA",
        sourcesContent: ["private-source-sentinel"],
      }),
    );

    const symbolize = createReportingSymbolicator(directory);

    const report = await symbolize({
      type: "TypeError",
      frames: [
        { filename: "_app/immutable/chunks/synthetic.js", lineno: 1, colno: 1 },
        { filename: "_app/immutable/chunks/old-release.js", lineno: 42, colno: 5 },
      ],
    });

    expect(report.frames).toEqual([
      { filename: "apps/control-plane/src/routes/settings/+page.svelte", lineno: 1, colno: 1 },
      { filename: "_app/immutable/chunks/old-release.js", lineno: 42, colno: 5 },
    ]);
    expect(JSON.stringify(report)).not.toContain("private-source-sentinel");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
