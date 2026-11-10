import { createArtifactStorage } from "../src/lib/server/artifact-storage.ts";

export const memoryArtifacts = () => {
  const objects = new Map<string, Uint8Array>();

  return createArtifactStorage({
    put: async (key, bytes) => {
      objects.set(key, bytes);
    },
    get: async (key) => {
      const value = objects.get(key);

      if (!value) throw new Error("Object not found");

      return value;
    },
    exists: async (key) => objects.has(key),
    list: async function* (prefix) {
      for (const [key, value] of objects)
        if (key.startsWith(prefix)) yield { key, size: value.byteLength };
    },
    remove: async (keys) => {
      for (const key of keys) objects.delete(key);
    },
  });
};
