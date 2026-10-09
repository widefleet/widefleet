import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import * as contract from "@platform/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Database } from "./database.ts";
import { artifacts } from "./schema.ts";
import type { ArtifactStorage } from "./storage.ts";

const generatedLocation = (file: string, browser: boolean) => {
  if (browser) {
    try {
      return new URL(file).pathname;
    } catch {
      return file;
    }
  }

  return file.slice(file.lastIndexOf("/") + 1);
};

export const createSymbolicator = (database: Database, storage: ArtifactStorage, appId: string) => {
  const releases = new Map<string, z.infer<typeof contract.artifact> | null>();
  const maps = new Map<string, TraceMap | null>();
  let downloaded = 0;

  const resolve = async (log: z.infer<typeof contract.runtimeLog>) => {
    if (!log.stack || !log.buildId) return log;

    let release = releases.get(log.buildId);

    if (release === undefined) {
      const [record] = await database
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.appId, appId),
            sql`${artifacts.metadata}->'debug'->>'build_id' = ${log.buildId}`,
          ),
        )
        .limit(1);

      release = record
        ? contract.artifact.parse({
            id: record.id,
            appId: record.appId,
            metadata: record.metadata,
            manifest: record.manifest,
            modules: record.modules,
          })
        : null;
      releases.set(log.buildId, release);
    }

    const frames: z.infer<typeof contract.stackFrame>[] = [];

    for (const line of log.stack.split("\n").slice(0, 64)) {
      const match =
        /^\s*at\s+(?:.*?\s+\()?(.+?):([0-9]+):([0-9]+)\)?\s*$/.exec(line) ??
        /^(?:.*?@)(.+?):([0-9]+):([0-9]+)\s*$/.exec(line);

      if (!match?.[1] || !match[2] || !match[3]) continue;

      const file = generatedLocation(match[1], log.source === "browser");
      const generatedLine = Number(match[2]);
      const generatedColumn = Number(match[3]);
      const mapName = release?.metadata.debug?.source_maps[file];

      const module = release?.modules.find(
        (entry) => entry.name === mapName && entry.type === "sourcemap",
      );

      let map = module ? maps.get(module.sha256) : null;

      if (module && map === undefined) {
        map = null;

        if (downloaded + module.size <= 32 * 1024 * 1024) {
          downloaded += module.size;
          const bytes = await storage.get(`apps/${appId}/modules/${module.sha256}`);

          if (bytes.isOk()) {
            try {
              map = new TraceMap(Buffer.from(bytes.value).toString("utf8"));
            } catch {
              // A malformed or missing map must not hide the original runtime error.
            }
          }
        }

        maps.set(module.sha256, map);
      }

      let original: ReturnType<typeof originalPositionFor> = {
        source: null,
        line: null,
        column: null,
        name: null,
      };

      if (map && generatedLine > 0 && generatedColumn > 0) {
        try {
          original = originalPositionFor(map, { line: generatedLine, column: generatedColumn - 1 });
        } catch {
          // Keep the generated frame if the map cannot resolve this location.
        }
      }

      frames.push({
        generatedFile: match[1],
        generatedLine,
        generatedColumn,
        file: original.source,
        line: original.line,
        column: original.column === null ? null : original.column + 1,
        name: original.name,
      });
    }

    return { ...log, frames };
  };

  return resolve;
};
