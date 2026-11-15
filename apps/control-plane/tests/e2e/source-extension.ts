import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { RuntimeExtension } from "../../src/lib/server/runtime-extension.ts";

const repositories = z.record(z.string(), z.record(z.string(), z.string()));

// Selected only when building the source-storage browser fixture.
export const createRuntimeExtension = (): RuntimeExtension => {
  if (process.env["WIDEFLEET_TEST_SOURCE_ENABLED"] !== "1") return {};
  const path = z.string().min(1).parse(process.env["WIDEFLEET_TEST_SOURCE_STATE"]);
  const read = async () => repositories.parse(JSON.parse(await readFile(path, "utf8")));
  const url = (id: string) => `https://git.example.test/apps/${id}.git`;

  return {
    source: {
      repository: async (id) => ((await read())[id] ? { url: url(id) } : null),
      create: async (id) => {
        const state = await read();
        state[id] = {};
        await writeFile(path, JSON.stringify(state));

        return { url: url(id) };
      },
      head: async (id, branch) => (await read())[id]?.[branch] ?? null,
      hasCommit: async (id, commit) => Object.values((await read())[id] ?? {}).includes(commit),
      credential: async (id) => ({
        url: url(id),
        username: "x",
        password: "synthetic-git-token",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
      remove: async (id) => {
        const state = await read();
        delete state[id];
        await writeFile(path, JSON.stringify(state));
      },
    },
  };
};
