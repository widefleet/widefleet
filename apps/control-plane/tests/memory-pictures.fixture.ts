import type { PictureStorage } from "@platform/auth-proxy/picture";

// The auth proxy's picture namespace for tests that run the proxy in Node.
export const memoryPictures = (): PictureStorage & { keys: () => string[] } => {
  const entries = new Map<string, { value: ArrayBuffer; metadata: unknown }>();

  return {
    keys: () => [...entries.keys()],
    getWithMetadata: async (key) => entries.get(key) ?? { value: null, metadata: null },
    put: async (key, value, options) => {
      entries.set(key, { value: value.slice().buffer, metadata: options.metadata });
    },
    delete: async (key) => {
      entries.delete(key);
    },
  };
};
