export const memoryStorage = () => {
  const objects = new Map<string, Uint8Array>();

  return {
    put: async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes);
    },
    get: async (key: string) => {
      const bytes = objects.get(key);

      if (!bytes) throw new Error("Missing fixture artifact");

      return bytes;
    },
    exists: async (key: string) => objects.has(key),
    async *list(prefix: string) {
      for (const [key, bytes] of objects)
        if (key.startsWith(prefix)) yield { key, size: bytes.length };
    },
    remove: async (keys: string[]) => {
      for (const key of keys) objects.delete(key);
    },
  };
};
