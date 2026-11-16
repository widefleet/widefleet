import type { Artifacts } from "@cloudflare/workers-types";
import { z } from "zod";
import type { SourceBackend } from "./source-backend.ts";

// workers-types retains an empty Disposable interface for pre-5.2 TypeScript consumers.
declare module "@cloudflare/workers-types" {
  interface Disposable {
    [Symbol.dispose](): void;
  }
}

export const artifactsSourceBinding = z.custom<Artifacts>(
  (value) =>
    z.object({ get: z.function(), create: z.function(), delete: z.function() }).safeParse(value)
      .success,
);

export const createArtifactsSource = (binding: Artifacts): SourceBackend => {
  const name = (id: string) => `app-${id}`;

  return {
    repository: async (id) => {
      try {
        using repo = await binding.get(name(id));

        return { url: (await repo.info()).remote };
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return null;
        throw error;
      }
    },
    create: async (id) => {
      const created = await binding.create(name(id), { setDefaultBranch: "main" });
      using repo = await binding.get(name(id));
      // Only short-lived tokens issued after checking app access reach Git clients.
      await repo.revokeToken(created.token);

      return { url: created.remote };
    },
    head: async (id, branch) => {
      using repo = await binding.get(name(id));

      return (await repo.log({ ref: `refs/heads/${branch}`, limit: 1 }))[0]?.hash ?? null;
    },
    hasCommit: async (id, commit) => {
      try {
        using repo = await binding.get(name(id));

        return (await repo.readCommit(commit)) !== null;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return false;
        throw error;
      }
    },
    credential: async (id, scope) => {
      using repo = await binding.get(name(id));
      const info = await repo.info();
      const token = await repo.createToken(scope, 300);

      return {
        url: info.remote,
        username: "x",
        password: token.plaintext.replace(/\?expires=.*$/, ""),
        expiresAt: token.expiresAt,
      };
    },
    remove: async (id) => {
      await binding.delete(name(id));
    },
  };
};
