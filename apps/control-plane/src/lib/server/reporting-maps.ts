import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { reportingFrame, type reportingError } from "@platform/contracts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";

export const createReportingSymbolicator = (directory = "build") => {
  const maps = new Map<string, TraceMap>();

  return async (report: z.infer<typeof reportingError>) => {
    const frames: z.infer<typeof reportingFrame>[] = [];

    for (const frame of report.frames) {
      const path = frame.filename.startsWith("_app/immutable/")
        ? join(directory, "reporting-maps", `${frame.filename}.map`)
        : frame.filename.startsWith("build/server/")
          ? join(directory, frame.filename.slice("build/".length) + ".map")
          : null;

      if (!path) {
        frames.push(frame);
        continue;
      }

      try {
        let map = maps.get(path);

        if (!map) {
          map = new TraceMap(await readFile(path, "utf8"));

          if (maps.size >= 32) maps.clear();
          maps.set(path, map);
        }

        const original = originalPositionFor(map, {
          line: frame.lineno,
          column: (frame.colno ?? 1) - 1,
        });

        const source = original.source;

        const location = source?.includes("node_modules/")
          ? null
          : /(?:^|\/)src\/([a-zA-Z0-9_./+[\]-]+)$/.exec(source ?? "");

        const filename = source?.includes("packages/contracts/src/")
          ? source.slice(source.indexOf("packages/contracts/src/"))
          : location
            ? `apps/control-plane/src/${location[1]}`
            : null;

        const parsed = reportingFrame.safeParse({
          filename,
          function:
            original.name && /^[a-zA-Z_$][a-zA-Z0-9_.$<>]{0,119}$/.test(original.name)
              ? original.name
              : frame.function,
          lineno: original.line,
          colno: original.column === null ? undefined : original.column + 1,
        });

        frames.push(parsed.success ? parsed.data : frame);
      } catch {
        // A previous browser release or an interrupted build can have no matching map.
        frames.push(frame);
      }
    }

    return { ...report, frames };
  };
};
