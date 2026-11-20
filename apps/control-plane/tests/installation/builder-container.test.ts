import {
  bundleRequest,
  bundleResult,
  documentRequest,
  documentResult,
} from "@platform/contracts/builds";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { installationSettings } from "./settings.ts";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

// A project without npm dependencies, so the build needs no registry.
const files = {
  "wrangler.jsonc": JSON.stringify({
    name: "notes",
    main: "src/index.ts",
    compatibility_date: "2026-10-01",
  }),
  "package.json": JSON.stringify({ name: "notes", private: true }),
  "src/index.ts": [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    "",
    "export default class extends WorkerEntrypoint {",
    "  /** Lists the notes. */",
    "  async list(): Promise<string[]> {",
    '    return ["first"];',
    "  }",
    "}",
    "",
  ].join("\n"),
};

describe.runIf(process.env["RUN_PACKAGED_EDGE_TESTS"] === "1")("Installed app builder", () => {
  it("builds and documents a project in the Compose builder service", async () => {
    const directory = await mkdtemp(join(tmpdir(), "widefleet-builder-"));
    const name = `widefleet-builder-${randomUUID()}`;
    const environmentFile = join(directory, "installation.env");
    const overrideFile = join(directory, "compose.yaml");

    await writeFile(
      environmentFile,
      Object.entries({
        ...installationSettings,
        PLATFORM_RUNTIME_IMAGE:
          process.env["PLATFORM_RUNTIME_IMAGE"] ?? "widefleet-runtime:setup-check",
        PLATFORM_DATA_DIRECTORY: directory,
      })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    // Only the test publishes the builder's port; the installation does not.
    await writeFile(overrideFile, `services:\n  builder:\n    ports: ["127.0.0.1::8080"]\n`);

    const compose = (...args: string[]) =>
      execute(
        "docker",
        [
          "compose",
          "--project-name",
          name,
          "--env-file",
          environmentFile,
          "-f",
          "infra/compose.base.yaml",
          "-f",
          overrideFile,
          ...args,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env["PATH"],
            HOME: process.env["HOME"],
            DOCKER_HOST: process.env["DOCKER_HOST"],
            DOCKER_CONFIG: process.env["DOCKER_CONFIG"],
          },
        },
      );

    try {
      await compose("up", "--detach", "--wait", "--no-deps", "builder");
      const origin = `http://${(await compose("port", "builder", "8080")).stdout.trim()}`;

      const post = (
        path: string,
        body: z.input<typeof bundleRequest> | z.input<typeof documentRequest>,
      ) =>
        fetch(`${origin}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const bundled = await post("/bundle", { files });

      expect(bundled.status).toBe(200);
      const build = bundleResult.parse(await bundled.json());

      expect(build.entry).toBe("src/index.ts");
      expect(build.metadata.entrypoints).toEqual(["default"]);

      const documented = await post("/document", {
        files,
        worker: build.worker,
        map: build.map,
        entry: build.entry,
        entrypoints: build.metadata.entrypoints,
      });

      expect(documented.status).toBe(200);
      const { documentation } = documentResult.parse(await documented.json());

      expect(documentation.entrypoints[0]?.methods).toEqual([
        expect.objectContaining({ name: "list", summary: "Lists the notes." }),
      ]);
      expect((await post("/bundle", { files: { "package.json": "{}" } })).status).toBe(422);
    } finally {
      await compose("down", "--volumes", "--remove-orphans").catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
