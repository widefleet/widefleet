import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import * as contract from "@platform/contracts";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.ts";
import { artifacts, cloudflareOperations, jobs } from "./schema.ts";
import {
  connectorReference,
  loadConnectorArtifact,
  connectorModuleScope,
} from "./connector-package.ts";
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

const appSymbols = async (database: Database, appId: string, buildId: string) => {
  const [record] = await database
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.appId, appId),
        sql`${artifacts.metadata}->'debug'->>'build_id' = ${buildId}`,
      ),
    )
    .limit(1);

  if (!record) return null;

  const release = contract.artifact.parse({
    id: record.id,
    appId: record.appId,
    metadata: record.metadata,
    modules: record.modules,
    manifest: record.manifest,
  });

  return {
    debug: release.metadata.debug,
    modules: release.modules,
    scope: `apps/${appId}`,
  };
};

const connectorSymbols = async (
  database: Database,
  storage: ArtifactStorage,
  target: { organizationId: string; name: string },
  version: string,
) => {
  const [job] = await database
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, version), eq(jobs.organizationId, target.organizationId)))
    .limit(1);

  const [operation] = job
    ? []
    : await database
        .select()
        .from(cloudflareOperations)
        .where(
          and(
            eq(cloudflareOperations.id, version),
            eq(cloudflareOperations.organizationId, target.organizationId),
          ),
        )
        .limit(1);

  // Runtime upgrades can prepare several connectors under the runtime job's version.
  const references = job
    ? [job.connector, ...z.array(z.unknown()).parse(job.connectors)]
    : [operation?.result];

  const reference = references
    .map((value) => connectorReference.safeParse(value).data)
    .find((value) => value?.name === target.name);

  if (!reference) return null;

  try {
    const { organizationId, release } = await loadConnectorArtifact(storage, reference);

    if (organizationId !== target.organizationId) return null;

    return {
      debug: release.metadata.debug,
      modules: release.modules,
      scope: connectorModuleScope(organizationId, release.name),
    };
  } catch {
    // Unavailable debug artifacts must not hide the original runtime error.
    return null;
  }
};

export const createSymbolicator = (
  database: Database,
  storage: ArtifactStorage,
  target: { appId: string } | { organizationId: string; name: string },
) => {
  const releases = new Map<string, Awaited<ReturnType<typeof appSymbols>>>();
  const maps = new Map<string, TraceMap | null>();
  let downloaded = 0;

  const resolve = async (log: z.infer<typeof contract.runtimeLog>) => {
    const version = "appId" in target ? log.buildId : log.connectorVersion;

    if (!log.stack || !version) return log;

    let release = releases.get(version);

    if (release === undefined) {
      release =
        "appId" in target
          ? await appSymbols(database, target.appId, version)
          : await connectorSymbols(database, storage, target, version);
      releases.set(version, release);
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
      const mapName = release?.debug?.source_maps[file];

      const module = release?.modules.find(
        (entry) => entry.name === mapName && entry.type === "sourcemap",
      );

      let map = module ? maps.get(module.sha256) : null;

      if (release && module && map === undefined) {
        map = null;

        if (downloaded + module.size <= 32 * 1024 * 1024) {
          downloaded += module.size;
          const bytes = await storage.get(`${release.scope}/modules/${module.sha256}`);

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
