// Optional effects must not reject into application operations or global error handlers.
export const runExtensionEffect = (effect: () => void | Promise<void>) => {
  try {
    void Promise.resolve(effect()).catch(() => {});
  } catch {
    // Synchronous extension failures have the same isolation as rejected promises.
  }
};
